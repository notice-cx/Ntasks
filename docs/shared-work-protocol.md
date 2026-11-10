# The Shared Work Protocol (draft)

The Shared Work Protocol writes down Ntasks's rules for shared work as an
open contract that other task tools, agent harnesses and adapters can
implement: the task objects and their states, who may answer for a person,
one holder per task, proof that work is done and where its change has
reached. Ntasks is its reference implementation, and a GitHub Issues
adapter is a second one. The draft is version 0, published at
[ntasks.notice.cx/spec](https://ntasks.notice.cx/spec/) and kept in
[`spec/`](../spec/README.md), with JSON Schemas for each object and its own
licenses, CC BY 4.0 for the text and Apache-2.0 for the schemas.

- [The protocol](../spec/protocol.md): why it exists, its objects, the state
  machine, the authority rules, the invariants and the conformance levels.
- [The MCP tool profile](../spec/mcp-profile.md) and
  [the HTTP binding](../spec/http-binding.md): Ntasks's tools and routes,
  mapped to the protocol.
- [Open questions](../spec/open-questions.md): where Ntasks's behavior is not
  yet a rule.
