// A booked session with an expert's public AI self, across two browsers: the
// owner opens sessions with house rules and an intake, a visitor books a time
// on the public page, opens the session link, asks, and gets an answer marked
// as AI from the owner's open vault; the owner reads the intake and the
// transcript, and ends the session.

import { expect, test } from "@playwright/test";
import { addFolder, createWithWallet, fitsPhone, installWallet, mockModel, recordBodies, setUpModel, writeMemory } from "./helpers";

const INTAKE = "CANARY-intake-e2e-tomatoes";

/** A fixed-offset zone in which it is about noon now, so the session's window is open whenever the test runs. */
function noonZone(): string {
  const h = 12 - new Date().getUTCHours();
  return h === 0 ? "Etc/UTC" : `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`;
}

test("a visitor books a session, talks with the expert's AI self under its house rules, and the expert reads it", async ({ page, context, browser }) => {
  await installWallet(context);
  const calls = await mockModel(page, () => "Add compost in autumn [1].");
  await createWithWallet(page);
  await addFolder(page, "Garden");
  await writeMemory(page, { title: "Compost", body: "Compost goes on the beds in autumn.", folder: "Garden" });
  await setUpModel(page, { name: "The gardener's AI self", folders: ["Notes"] });

  const pub = page.getByRole("form", { name: "Public AI self" });
  await pub.getByLabel("Handle").fill("gardener-e2e");
  await pub.getByLabel("Name it uses").fill("The gardener's AI self");
  await pub.getByLabel("Garden").check();
  await pub.getByRole("button", { name: "Save and publish" }).click();
  await expect(page.getByTestId("public-url")).toBeVisible();

  const offer = page.getByRole("form", { name: "Sessions" });
  await offer.getByLabel("Topics").fill("Soil, Vegetables");
  await offer.getByLabel("Questions in a session").fill("3");
  await offer.getByLabel("House rules").fill("Not professional advice. Check local rules before spraying anything.");
  await offer.getByLabel("Window 1 from").fill("08:00");
  await offer.getByLabel("Window 1 to").fill("16:00");
  for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) await offer.getByLabel(d, { exact: true }).check();
  await offer.getByLabel("Time zone").fill(noonZone());
  await offer.getByLabel("Intake question 1").fill("What do you grow?");
  await offer.getByRole("button", { name: "Save sessions" }).click();
  await expect(page.getByTestId("sessions")).toContainText("Taking bookings");
  await fitsPhone(page, "AI self, sessions open");

  // A visitor books on the public page.
  const guest = await browser.newContext();
  const visitor = await guest.newPage();
  const sent = recordBodies(visitor);
  await visitor.goto("/@gardener-e2e");
  const book = visitor.getByTestId("session-book");
  await expect(book).toContainText("Not professional advice");
  await book.getByLabel("Topic").selectOption("Soil");
  await book.getByLabel(/What do you grow/).fill(`Tomatoes. ${INTAKE}`);
  await book.getByLabel(/I understand that I am talking with an AI/).check();
  await fitsPhone(visitor, "The public page, booking a session");
  await book.getByRole("button", { name: "Book the session" }).click();
  const link = (await visitor.getByTestId("session-link").innerText()).trim();
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]{43}$/);
  expect(sent.join("\n")).not.toContain(INTAKE);

  await visitor.goto(link);
  await expect(visitor.getByTestId("session-rules")).toContainText("Check local rules before spraying anything.");
  await expect(visitor.getByTestId("session-status")).toContainText("3 questions left", { timeout: 20_000 });
  await visitor.getByLabel("Your question").fill("When does compost go on?");
  await visitor.getByRole("button", { name: "Ask" }).click();
  const turn = visitor.getByTestId("session-turn").first();
  await expect(turn).toContainText("Add compost in autumn.", { timeout: 30_000 });
  await expect(turn.locator(".chat-by-kind")).toHaveText("AI");
  await expect(visitor.getByTestId("session-status")).toContainText("2 questions left");
  await fitsPhone(visitor, "A session, one answer");
  expect(calls.at(-1)!.system).toContain("House rules the owner set for every session");
  expect(calls.at(-1)!.system).toContain(INTAKE);
  expect(sent.join("\n")).not.toContain("When does compost go on");

  // The owner reads the booking: the intake, what the visitor agreed to, and the transcript; then ends it.
  const booking = page.getByTestId("booking").first();
  await expect(booking).toContainText("Soil", { timeout: 20_000 });
  await booking.getByRole("button", { name: "Read it" }).click();
  await expect(booking.getByTestId("booking-detail")).toContainText(INTAKE);
  await expect(booking.getByTestId("booking-detail")).toContainText("I understand that I am talking with an AI");
  await expect(booking.getByTestId("transcript-turn")).toContainText("When does compost go on?", { timeout: 20_000 });
  await booking.getByRole("button", { name: "End" }).click();
  await expect(page.getByTestId("booking").first()).toHaveAttribute("data-state", "ended");
  await visitor.reload();
  await expect(visitor.getByTestId("session-status")).toContainText("This session has ended.");
  await guest.close();
});
