import assert from "node:assert/strict";
import test from "node:test";
import {
  isSameOriginMutation,
  readBoundedJsonObject,
  readBoundedUrlEncodedForm,
} from "../app/mutation-request.mjs";

test("same-origin exige Origin exacto o el fallback explícito del navegador", () => {
  assert.equal(isSameOriginMutation(request("", {
    Origin: "https://fundosmart.test",
  })), true);
  assert.equal(isSameOriginMutation(request("", {
    Origin: "https://evil.fundosmart.test",
  })), false);
  assert.equal(isSameOriginMutation(request("", {
    "Sec-Fetch-Site": "same-origin",
  })), true);
  assert.equal(isSameOriginMutation(request("", {
    "Sec-Fetch-Site": "same-site",
  })), false);
});

test("formularios aceptan sólo urlencoded UTF-8 dentro del límite", async () => {
  const valid = await readBoundedUrlEncodedForm(request(
    "action=request&scope=account",
    { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
  ));
  assert.ok(valid instanceof URLSearchParams);
  assert.equal(valid.get("scope"), "account");

  const wrongType = await readBoundedUrlEncodedForm(request(
    "action=request",
    { "Content-Type": "text/plain" },
  ));
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).code, "UNSUPPORTED_MEDIA_TYPE");
});

test("límites declarados y transmitidos fallan 413 antes de parsear", async () => {
  const declared = await readBoundedUrlEncodedForm(request("a=1", {
    "Content-Length": "9000",
    "Content-Type": "application/x-www-form-urlencoded",
  }));
  assert.equal(declared.status, 413);

  const streamed = await readBoundedUrlEncodedForm(request("a=12345", {
    "Content-Type": "application/x-www-form-urlencoded",
  }), 4);
  assert.equal(streamed.status, 413);
  assert.equal((await streamed.json()).code, "REQUEST_TOO_LARGE");
});

test("JSON staff exige media type, objeto y límite estricto", async () => {
  const valid = await readBoundedJsonObject(request('{"action":"save"}', {
    "Content-Type": "application/json; charset=utf-8",
  }));
  assert.deepEqual(valid, { action: "save" });

  const array = await readBoundedJsonObject(request("[]", {
    "Content-Type": "application/json",
  }));
  assert.equal(array.status, 400);

  const plain = await readBoundedJsonObject(request('{"action":"save"}', {
    "Content-Type": "text/plain",
  }));
  assert.equal(plain.status, 415);
});

function request(body, headers) {
  return new Request("https://fundosmart.test/api/test", {
    method: "POST",
    headers,
    body: body || undefined,
  });
}
