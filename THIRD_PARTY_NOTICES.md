# Third-party notices

Ntasks's own source is covered by [AGPL-3.0-only](LICENSE). Third-party
software keeps its original terms.

## NoticeOS

Parts of Ntasks come from [NoticeOS](https://github.com/notice-cx/NoticeOS),
which has the same copyright holder and the same licence, AGPL-3.0-only.

## Beads

The Ntasks task model follows [Beads](https://github.com/gastownhall/beads).
Where Ntasks adapts Beads source, such as test cases ported from its backend
conformance suite, the adapted file names Beads at its top, and the adapted
material keeps the Beads copyright notice and licence:
[MIT License, Copyright (c) 2025 Beads Contributors](licenses/beads-LICENSE.txt).

## npm packages

Packages installed from npm keep their own licences, shipped inside each
package. The pinned set is in [pnpm-lock.yaml](pnpm-lock.yaml). To list the
packages installed for your platform and their licences, run:

```sh
pnpm licenses list --recursive
```
