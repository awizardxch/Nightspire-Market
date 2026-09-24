# Nightspire Market — demo preview bundle (sample data)

Standalone static preview of the `venue-web` board. `demo-app.js` is the
repo's `app.js` with only the `api()` layer swapped to serve embedded sample
data (`demo-data.js`) — no network calls, still read-only, nothing signs or
settles. Purple DEMO banner marks it as a preview, not a live relay.

Regenerate with `/tmp/build_demo.py` from `~/workspace/nightspire-demo/`.
