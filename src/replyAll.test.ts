import { describe, expect, it } from "vitest";
import { demoMail, replyAllRecipients } from "./model";

describe("reply all recipients", () => {
  it("uses Reply-To, includes To and Cc, excludes self and deduplicates", () => {
    expect(
      replyAllRecipients(
        {
          ...demoMail[0],
          from: "sender@example.org",
          replyTo: '"Support, Team" <reply@example.org>',
          to: 'Me <ME@example.org>, "Doe, Jane" <jane@example.org>',
          cc: "JANE@example.org, colleague@example.org, me@example.org",
        },
        "me@example.org",
      ),
    ).toBe("reply@example.org, jane@example.org, colleague@example.org");
  });
  it("falls back to From and supports old cached messages without Cc", () => {
    expect(
      replyAllRecipients(
        {
          ...demoMail[0],
          from: "Sender <sender@example.org>",
          replyTo: "",
          to: "me@example.org",
        },
        "me@example.org",
      ),
    ).toBe("sender@example.org");
  });
  it("replies to the other recipients of a self-sent message", () => {
    expect(
      replyAllRecipients(
        {
          ...demoMail[0],
          from: "me@example.org",
          replyTo: "",
          to: "other@example.org",
          cc: "third@example.org",
        },
        "me@example.org",
      ),
    ).toBe("other@example.org, third@example.org");
  });
});
