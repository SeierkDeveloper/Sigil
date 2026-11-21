// The speech model a node hands out for voice: each file, its size, and the total a phone downloads once.
import { ask, bad, baseUrl, done, note, ok } from "./lib";

const base = baseUrl(await ask("SIGIL_URL", "Address of the node (https://...)"));
const voice = (await (await fetch(`${base}/api/voice`)).json()) as { enabled: boolean; model: string };
if (!voice.enabled) {
  note("Voice is off on this node (SIGIL_VOICE).");
  done();
}
let total = 0;
for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_quantized.onnx"]) {
  const r = await fetch(`${base}/models/${voice.model}/${f}`, { method: "GET" });
  const size = Number(r.headers.get("content-length") ?? (await r.arrayBuffer()).byteLength);
  if (r.ok) {
    total += size;
    ok(f, `${(size / 1_048_576).toFixed(1)} MB`);
  } else bad(f, `answered ${r.status}`);
}
note(`total ${(total / 1_048_576).toFixed(1)} MB, fetched once into SIGIL_MODEL_DIR on the node and kept by the browser after the first use`);
done();
