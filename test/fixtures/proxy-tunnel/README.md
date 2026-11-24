Test-only self-signed certificate for `test/env-proxy.test.js` (proxy tunnel
tests). It is trusted only inside the child processes those tests start, via
`NODE_EXTRA_CA_CERTS`, for the made-up host
`tunnel-target.vibe-usage-proxy-test.invalid`. Not used anywhere else.
