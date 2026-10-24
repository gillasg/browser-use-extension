## Sessions and files

`--session <name>` keeps variables, tabs and files together; the default is `cli` (and `mcp` for
the MCP server). Files (`page.saveMedia`, `page.network.save`, artifacts, crawls) land in the
session's workspace under browserkit's data folder ({{workspace}}). `browserkit journal <session>`
shows what a session ran. `artifact(name, data)` writes a file; `checkpoint(name, value)` and
`loadCheckpoint` persist JSON across resets.
