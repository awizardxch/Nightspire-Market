# Vendored crates

Two crates.io dependencies are vendored here as `[patch.crates-io]` path
patches (see the workspace root `Cargo.toml`) because their `.crate` files
are unreachable from this sandbox's network (the specific objects stall on
both `static.crates.io` and the `/api/v1/.../download` redirector, and the
crates.io API itself is unreachable from here). Everything else resolves from
crates.io normally.

## solana-native-token 2.2.1

- Upstream repo: https://github.com/anza-xyz/solana-sdk
- Tag: `native-token@v2.2.1`
- Directory: `native-token/`
- Contents: `src/lib.rs` copied verbatim; `Cargo.toml` hand-normalized from
  the workspace-inherited manifest (authors/repository/homepage/license/
  edition resolved from the workspace root `Cargo.toml` at that tag —
  `cargo publish` performs the same normalization).
- Why needed: dependency of `solana-program 2.2.1` (via `anchor-lang`).

## spl-token 7.0.0

- Upstream repo: https://github.com/solana-program/token
- Tag: `program@v7.0.0`
- Directory: `program/` (the on-chain Token program crate doubles as the
  client library exposing `instruction`, `state`, and `ID`)
- Contents: `src/` copied verbatim; `Cargo.toml` copied verbatim except the
  trailing `[lints] workspace = true` (unresolvable outside the upstream
  workspace; lint configuration does not affect compiled code).
- Why needed: dependency of `anchor-spl` with `features = ["token"]`
  (SPL Token CPI helpers: `transfer`, `close_account`, `TokenAccount`, `ID`).

## Verification

`_src/` holds sparse git clones of the two upstream repos pinned to the tags
above, so the vendored copies can be diffed against upstream at any time:

    diff -r _src/solana-sdk/native-token/src vendor/solana-native-token/src
    diff -r _src/token/program/src vendor/spl-token/src

## Replacing the vendored copies

If the sandbox network can reach crates.io normally, delete this `vendor/`
directory (except this README) and remove the `[patch.crates-io]` section
from the workspace root `Cargo.toml`; the crates will then resolve from the
registry like every other dependency.
