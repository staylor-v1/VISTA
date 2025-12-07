# VISTA Examples

This directory contains example code demonstrating how to use various VISTA features.

## MCP Client Example

**File:** `mcp_client_example.py`

Demonstrates how Atlas-UI-3 or other MCP clients would connect to and use the VISTA MCP server.

### Running the Example

```bash
python examples/mcp_client_example.py
```

This example shows the parameter patterns for calling all 12 MCP tools exposed by VISTA.

### Actual MCP Client Connection

To actually connect to a running VISTA MCP server from Atlas-UI-3 or another MCP client:

1. Start the VISTA MCP server:
   ```bash
   cd backend
   python mcp_server.py
   ```

2. From your client application (e.g., Atlas-UI-3), use the MCP Python SDK:
   ```python
   from mcp import ClientSession, StdioServerParameters
   from mcp.client.stdio import stdio_client
   
   server_params = StdioServerParameters(
       command="python",
       args=["backend/mcp_server.py"]
   )
   
   async with stdio_client(server_params) as (read, write):
       async with ClientSession(read, write) as session:
           await session.initialize()
           
           # Call tools
           result = await session.call_tool(
               "get_projects",
               arguments={"username": "alice@example.com", "skip": 0, "limit": 10}
           )
   ```

## Additional Examples

More examples will be added here as VISTA features expand.
