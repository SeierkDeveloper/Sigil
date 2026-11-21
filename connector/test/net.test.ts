import { describe, expect, it } from "vitest";
import { isLoopbackHost, isSafeBaseUrl, samePath } from "../src/net";

describe("where the connector sends the app key's token", () => {
  it("is https, or plain http only to this machine", () => {
    expect(isSafeBaseUrl("https://sigil.example")).toBe(true);
    expect(isSafeBaseUrl("http://localhost:3210")).toBe(true);
    expect(isSafeBaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isSafeBaseUrl("http://[::1]:8080")).toBe(true);
    expect(isSafeBaseUrl("http://sigil.example")).toBe(false);
    expect(isSafeBaseUrl("http://192.168.1.10:3000")).toBe(false);
    expect(isSafeBaseUrl("ftp://sigil.example")).toBe(false);
    expect(isSafeBaseUrl("not a url")).toBe(false);
  });

  it("serves its HTTP mode on this machine only unless told otherwise, behind a path compared in constant time", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.2")).toBe(false);
    expect(samePath("/mcp/abc", "/mcp/abc")).toBe(true);
    expect(samePath("/mcp/abd", "/mcp/abc")).toBe(false);
    expect(samePath("/mcp/ab", "/mcp/abc")).toBe(false);
  });
});
