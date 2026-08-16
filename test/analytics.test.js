import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEvent } from "../apps/web/analytics-privacy.js";

test("analytics removes private room details and element content but keeps server-hash inputs", () => {
  const event = sanitizeEvent({
    event: "$autocapture",
    properties: {
      $current_url: "https://who-said-dis.com/room/SECRETROOM12?query=secret#join=SECRET",
      $pathname: "/room/SECRETROOM12",
      $raw_user_agent: "identifying browser details",
      $elements_chain: "span.icon:nth-child=\"1\";button#private-id:attr__data-capture-id=\"room_join\";form.join-card:",
      $elements: [
        { tag_name: "span", text: "private text", attr__class: "icon" },
        {
          tag_name: "button",
          text: "private text",
          attr__id: "join-button",
          "attr__data-capture-id": "room_join"
        },
        { tag_name: "form", attr__class: "join-card" }
      ]
    }
  });

  assert.equal(event.properties.$current_url, "https://who-said-dis.com/room/:room");
  assert.equal(event.properties.$pathname, "/room/:room");
  assert.equal(event.properties.$raw_user_agent, "identifying browser details");
  assert.equal(event.properties.capture_id, "room_join");
  assert.deepEqual(event.properties.$elements, [{
    tag_name: "button",
    "attr__data-capture-id": "room_join"
  }]);
  assert.equal(
    event.properties.$elements_chain,
    "button:attr__data-capture-id=\"room_join\"nth-child=\"0\"nth-of-type=\"0\""
  );
});

test("analytics rejects unmarked interactions and unexpected event types", () => {
  assert.equal(sanitizeEvent({ event: "$autocapture", properties: { $elements: [] } }), null);
  assert.equal(sanitizeEvent({ event: "$exception", properties: {} }), null);
});

test("analytics accepts the current serialized PostHog element-chain format", () => {
  const event = sanitizeEvent({
    event: "$autocapture",
    properties: {
      $elements_chain: "span:;button:attr__data-capture-id=\"game_start\"nth-child=\"2\";section:attr__id=\"private\""
    }
  });

  assert.equal(event.properties.$elements[0]["attr__data-capture-id"], "game_start");
  assert.equal(event.properties.capture_id, "game_start");
  assert.doesNotMatch(event.properties.$elements_chain, /private|section|span/);
});
