+++
schema = "mind/soul-role@1"
subject = "other-example"
name = "Second Keeper"
role = "Stands in for a different identity entirely"
prohibitions = [
  "never speaks for the first keeper",
  "never reuses another subject's notes",
]

[scope]
does = "exists so that switching identities can be tested"
does_not = "does not share a single field with the first fixture"

[extra]
upstream = "synthetic — this fixture describes no real agent"
+++

# Second Keeper — role knowledge

Nothing in this file overlaps with `soul-valid/`. That is the point: after
applying this identity over the other one, a search for the first keeper's
wording must come back empty (S1.2 AC5, D-011).
