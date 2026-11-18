import { closeSync, createReadStream, openSync, readSync } from 'node:fs';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';

// Streaming reader for Zstandard files (RFC 8878) that may be far larger than
// memory: Codex compresses cold rollouts to `.jsonl.zst`, and single files of
// 2.5 GB compressed / 3.5 GB decompressed exist on real machines.
//
// Node's decoder cannot be trusted with the frame structure on its own. On
// Node 22 (22.19 measured; the Windows app bundles 22.23) both the one-shot
// and the stream decoder stop after the first frame without an error, and a
// truncated frame decodes to its complete blocks without an error. Node 24
// decodes every frame and rejects truncation. So the frames are located here
// from their headers and each one is decoded on its own, and a frame that
// declares its decompressed size must produce exactly that many bytes. Any
// structural problem fails the whole file: a caller never sees a partial file
// as if it were complete.

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
// Block_Maximum_Size: no block (compressed, raw, or RLE-decoded) exceeds 128 KiB.
const MAX_BLOCK_SIZE = 128 * 1024;
// Header reads only: blocks are usually close to 128 KiB apart, so a larger
// window would mostly read compressed payload that is skipped anyway.
const PROBE_WINDOW = 512;
// Measured on a 1.8 GB rollout: 565 MB/s with the stream defaults, 930 MB/s
// with these, about what the zstd CLI does on the same machine.
const READ_HIGH_WATER_MARK = 1024 * 1024;
const DECODER_CHUNK_SIZE = 256 * 1024;

/** A file that is not complete, valid Zstandard data (as opposed to an I/O error). */
export class ZstdDecodeError extends Error {
  constructor(message, filePath, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ZstdDecodeError';
    this.filePath = filePath;
  }
}

export function isZstdDecodeError(err) {
  return err instanceof ZstdDecodeError;
}

/** Node >= 22.15 / 23.8 ship a zstd decoder in node:zlib; Node 20 does not. */
export function zstdDecoderAvailable() {
  return typeof zlib.createZstdDecompress === 'function';
}

// Positioned reads through a small window, so walking ~20k block headers of a
// multi-gigabyte file costs one small read per block instead of loading it.
function windowedReader(fd, size) {
  const window = Buffer.allocUnsafe(PROBE_WINDOW);
  let windowStart = 0;
  let windowLength = 0;
  return (position, length) => {
    if (position + length > size) return null;
    if (position < windowStart || position + length > windowStart + windowLength) {
      windowStart = position;
      windowLength = readSync(fd, window, 0, Math.min(PROBE_WINDOW, size - position), position);
      if (windowLength < length) return null;
    }
    return window.subarray(position - windowStart, position - windowStart + length);
  };
}

/**
 * Locate every standard frame in the first `size` bytes of a Zstandard file
 * from its headers alone: `[{ start, end, contentSize }]`, `contentSize` null
 * when the frame does not declare it. Skippable frames are stepped over. A bad
 * magic number, a reserved bit, an oversized block, an incomplete frame, or no
 * frame at all throws ZstdDecodeError.
 */
export function zstdFrames(filePath, size) {
  const fd = openSync(filePath, 'r');
  try {
    const read = windowedReader(fd, size);
    const fail = (what, position) => {
      throw new ZstdDecodeError(`${what} at byte ${position}`, filePath);
    };
    const frames = [];
    let pos = 0;
    while (pos < size) {
      const magicBytes = read(pos, 4);
      if (!magicBytes) fail('incomplete Zstandard frame', pos);
      const magic = magicBytes.readUInt32LE(0);
      if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
        const lengthBytes = read(pos + 4, 4);
        if (!lengthBytes) fail('incomplete skippable frame', pos);
        const end = pos + 8 + lengthBytes.readUInt32LE(0);
        if (end > size) fail('incomplete skippable frame', pos);
        pos = end;
        continue;
      }
      if (magic !== ZSTD_MAGIC) fail('invalid Zstandard frame magic', pos);

      const start = pos;
      const descriptorBytes = read(pos + 4, 1);
      if (!descriptorBytes) fail('incomplete Zstandard frame header', pos);
      const descriptor = descriptorBytes[0];
      if ((descriptor & 0x08) !== 0) fail('reserved Zstandard frame-header bit', pos + 4);
      const singleSegment = (descriptor & 0x20) !== 0;
      const hasChecksum = (descriptor & 0x04) !== 0;
      const dictionaryFlag = descriptor & 0x03;
      const contentSizeFlag = descriptor >>> 6;
      const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
      const contentSizeAt = pos + 5 + (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag);
      let contentSize = null;
      if (contentSizeBytes > 0) {
        const field = read(contentSizeAt, contentSizeBytes);
        if (!field) fail('incomplete Zstandard frame header', pos);
        contentSize = contentSizeBytes === 1 ? field[0]
          : contentSizeBytes === 2 ? field.readUInt16LE(0) + 256
            : contentSizeBytes === 4 ? field.readUInt32LE(0)
              : Number(field.readBigUInt64LE(0));
      }
      pos = contentSizeAt + contentSizeBytes;

      for (;;) {
        const blockBytes = read(pos, 3);
        if (!blockBytes) fail('incomplete Zstandard frame', start);
        const blockHeader = blockBytes.readUIntLE(0, 3);
        const blockType = (blockHeader >>> 1) & 0x03;
        const blockSize = blockHeader >>> 3;
        if (blockType === 0x03) fail('reserved Zstandard block type', pos);
        if (blockSize > MAX_BLOCK_SIZE) fail('oversized Zstandard block', pos);
        // An RLE block stores one byte; its size field is the decoded length.
        pos += 3 + (blockType === 0x01 ? 1 : blockSize);
        if (pos > size) fail('incomplete Zstandard frame', start);
        if ((blockHeader & 1) !== 0) break;
      }
      if (hasChecksum) pos += 4;
      if (pos > size) fail('incomplete Zstandard frame', start);
      frames.push({ start, end: pos, contentSize });
    }
    if (frames.length === 0) throw new ZstdDecodeError('no Zstandard frame', filePath);
    return frames;
  } finally {
    closeSync(fd);
  }
}

function isDecoderError(err) {
  return typeof err?.code === 'string' && /^(?:Z_|ZSTD_)/.test(err.code);
}

/**
 * Decompressed contents of the first `size` bytes of a Zstandard file, as a
 * stream of Buffers, one frame after another, never more than one decoder
 * buffer in memory. `counter.bytes` (when given) accumulates the decompressed
 * length. Decoder failures and size mismatches throw ZstdDecodeError; file
 * system errors (the file vanished, permissions) are rethrown as they are.
 */
export async function* zstdFileChunks(filePath, size, counter = null) {
  if (!zstdDecoderAvailable()) {
    throw new Error(`zstd decoder unavailable in Node ${process.version}`);
  }
  const frames = zstdFrames(filePath, size);
  for (const frame of frames) {
    const source = createReadStream(filePath, {
      start: frame.start,
      end: frame.end - 1,
      highWaterMark: READ_HIGH_WATER_MARK,
    });
    const decoder = zlib.createZstdDecompress({ chunkSize: DECODER_CHUNK_SIZE });
    pipeline(source, decoder, () => {});
    let produced = 0;
    try {
      for await (const chunk of decoder) {
        produced += chunk.length;
        if (counter) counter.bytes += chunk.length;
        yield chunk;
      }
    } catch (err) {
      if (isDecoderError(err)) {
        throw new ZstdDecodeError(`${err.message} in frame at byte ${frame.start}`, filePath, err);
      }
      throw err;
    } finally {
      source.destroy();
      decoder.destroy();
    }
    if (frame.contentSize != null && produced !== frame.contentSize) {
      throw new ZstdDecodeError(
        `frame at byte ${frame.start} decoded to ${produced} bytes, header says ${frame.contentSize}`,
        filePath
      );
    }
  }
}
