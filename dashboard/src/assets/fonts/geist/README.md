# Geist

`Geist-Variable.woff2` and `GeistMono-Variable.woff2` are copied unchanged
from the `geist` npm package, version 1.7.0
(`dist/fonts/geist-sans/` and `dist/fonts/geist-mono/`), under the SIL
Open Font License 1.1 in `LICENSE.txt`. They are vendored because the
dashboard needs only these two files, while the package declares a peer
dependency on `next`, which npm installs and which brings in sharp.

To update, copy the same two files from a newer `geist` release and
update the version above.
