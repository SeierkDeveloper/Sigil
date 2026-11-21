// Voice in the AI self's test chat, in a real browser with a fake microphone:
// turning voice on loads the speech model (the tiny stand-in kept in the
// repository, served by the node like the real one), what the microphone
// hears is written down on the device, and the answer is read aloud with a
// voice that runs on the device. No audio and no question reach Sigil.

import { expect, test } from "@playwright/test";
import { createWithWallet, installWallet, mockModel, recordBodies, setUpModel, writeMemory, openTab } from "./helpers";

test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }, permissions: ["microphone"] });

test("the test chat listens on the device and reads the answer aloud", async ({ page, context, baseURL }) => {
  await installWallet(context);
  // The device's speech synthesis, played by the test: one voice that runs on the device, and a record of what it says.
  await context.addInitScript(() => {
    const w = window as unknown as { __spoken: string[] };
    w.__spoken = [];
    const voice = { name: "On this device", lang: "en-US", localService: true, default: true, voiceURI: "local" };
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { getVoices: () => [voice], speak: (u: { text: string }) => w.__spoken.push(u.text), cancel() {}, addEventListener() {}, removeEventListener() {} },
    });
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
      text: string;
      voice: unknown = null;
      lang = "";
      constructor(text: string) {
        this.text = text;
      }
    };
  });
  const models: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/models/")) models.push(new URL(r.url()).pathname);
  });
  const sent = recordBodies(page);
  const calls = await mockModel(page, () => "You parked on level 3, by the lift [1].");
  await createWithWallet(page);
  await writeMemory(page, { title: "Parking", body: "The car is on level 3, by the lift." });
  await setUpModel(page, { name: "Sam's AI self", folders: ["Notes"] });

  const chat = page.locator(".self-chat");
  const voice = chat.getByTestId("voice");
  await expect(voice).toContainText("about 41 MB");
  expect(models.filter((m) => m.includes("whisper"))).toEqual([]);
  await voice.getByRole("button", { name: "Turn on voice" }).click();
  await expect(voice.getByTestId("voice-mic")).toHaveText(/Speak/, { timeout: 30_000 });
  expect(models).toEqual(expect.arrayContaining(["/models/sigil/tiny-whisper.en/tokenizer.json", "/models/sigil/tiny-whisper.en/onnx/encoder_model_quantized.onnx", "/models/sigil/tiny-whisper.en/onnx/decoder_model_quantized.onnx"]));

  await voice.getByTestId("voice-mic").click();
  await expect(voice).toContainText("Listening");
  await page.waitForTimeout(1200);
  await voice.getByTestId("voice-mic").click();
  await expect(chat.getByLabel("Question")).toHaveValue("Where did I park the car?", { timeout: 30_000 });

  await voice.getByLabel("Read answers aloud").check();
  await chat.getByRole("button", { name: "Ask" }).click();
  await expect(chat.getByTestId("chat-turn").first()).toContainText("You parked on level 3");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual(["You parked on level 3, by the lift."]);
  expect(calls.at(-1)?.messages.at(-1)?.content).toBe("Where did I park the car?");

  // The voice choice is kept, encrypted, for the next time the vault opens.
  await page.reload();
  await page.getByTestId("method-wallet").click();
  await openTab(page, "AI self");
  await expect(page.locator(".self-chat").getByTestId("voice-mic")).toBeVisible({ timeout: 30_000 });

  // What was said never went to Sigil: only the model's public files came from it.
  const wire = sent.filter((s) => s.includes(baseURL!)).join("\n");
  expect(wire).not.toContain("Where did I park the car");
  expect(wire).not.toContain("audio");
});
