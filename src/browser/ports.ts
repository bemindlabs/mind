/**
 * The loopback ports a browser task's MCP server is published on.
 *
 * mind's dev block is 30700–30799 (the port standard on this server); a2a
 * has 30700, the web page 30701, the platform's dev pair 30710–30711 and the
 * app's Metro 30720. Browser tasks take 30730–30749: twenty at once, which is
 * more than one machine's GPU can drive. The port is bound to 127.0.0.1 only —
 * the MCP server can drive a browser, so it is never on the LAN or the tailnet.
 */
export const BROWSER_PORT_FIRST = 30_730;
export const BROWSER_PORT_LAST = 30_749;
