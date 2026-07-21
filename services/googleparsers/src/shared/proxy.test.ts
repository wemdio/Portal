import assert from "node:assert/strict";
import test from "node:test";
import { maskProxy, normalizeProxyUrl, toPlaywrightProxy } from "./proxy";

test("splits authenticated proxy URL into Playwright fields", () => {
  assert.deepEqual(
    toPlaywrightProxy("http://user%40mail:p%40ss@127.0.0.1:8080"),
    {
      server: "http://127.0.0.1:8080",
      username: "user@mail",
      password: "p@ss"
    }
  );
});

test("normalizes a proxy without a scheme", () => {
  assert.equal(normalizeProxyUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.deepEqual(toPlaywrightProxy("127.0.0.1:8080"), {
    server: "http://127.0.0.1:8080"
  });
});

test("never exposes proxy credentials in logs", () => {
  const masked = maskProxy("http://secret-user:secret-pass@127.0.0.1:8080");
  assert.equal(masked, "http://127.0.0.1:8080");
  assert.equal(masked.includes("secret"), false);
});
