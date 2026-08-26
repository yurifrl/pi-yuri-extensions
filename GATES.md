# Gates: shared Pi and OMP checkpoint

OWNS: extensions/modules/checkpoint/**, extensions/pi/**, extensions/omp/**, package.json, scripts/verify-checkpoint.mjs, GATES.md

Scope: make the bundled checkpoint SKILL.md discoverable by both Pi and OMP without loading either runtime's adapter in the other.

- [x] G0: this ledger has valid runnable completion checks
  CHECK: node /Users/yuri/.omp/agent/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-yuri-extensions; path=50160c8752fa/33 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] G1: checkpoint core retains metadata preparation behavior
  CHECK: bun scripts/verify-checkpoint.mjs shared
  EXPECT: checkpoint shared behavior verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-yuri-extensions; path=50160c8752fa/33 entries; EXPECT=matched; output-sha256=08249a2e83b9a33d658c8072e1131ffc3f6792f5bc9c65ced6b2770da8164871; output-bytes=36

- [x] G2: Pi and OMP package declarations expose the bundled checkpoint skill
  CHECK: bun scripts/verify-checkpoint.mjs wiring
  EXPECT: checkpoint runtime wiring verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/yuri/DotFiles/pi-extentions/pi-yuri-extensions; path=50160c8752fa/33 entries; EXPECT=matched; output-sha256=bd5baea5237264c4c73a7e8f798f112f23a21be07ed10d4d76547d51f0a7cd6e; output-bytes=71
