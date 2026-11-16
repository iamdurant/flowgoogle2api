export type ModelDef = {
  id: string;
  aliases: string[];
  rpcModel: string;
  modelKey: string;
  label: string;
};

export const MODELS: ModelDef[] = [
  {
    id: "nano-banana-pro",
    aliases: ["nano-banana-pro", "nano_banana_pro", "pro", "gem_pix_2", "GEM_PIX_2"],
    rpcModel: "GEM_PIX_2",
    modelKey: "nano_banana_pro",
    label: "🍌 Nano Banana Pro",
  },
  {
    id: "nano-banana-2.1",
    aliases: ["nano-banana-2.1", "nano-banana-21", "nano_banana_2_1", "beluga", "BELUGA"],
    rpcModel: "BELUGA",
    modelKey: "beluga_display",
    label: "🍌 Nano Banana 2.1",
  },
  {
    id: "nano-banana-2-lite",
    aliases: ["nano-banana-2-lite", "nano_banana_2_lite", "lite", "harbor_seal", "HARBOR_SEAL"],
    rpcModel: "HARBOR_SEAL",
    modelKey: "harbor_seal",
    label: "🍌 Nano Banana 2 Lite",
  },
];

export function findModel(name?: string): ModelDef {
  if (!name) return MODELS[0];
  const n = name.trim();
  for (const m of MODELS) {
    if (m.id === n) return m;
    if (m.aliases.some((a) => a.toLowerCase() === n.toLowerCase())) return m;
  }
  return MODELS[0];
}

// flow project default aspect enum (proto order, calibrated from the settings UI)
export const ASPECT_ENUM: Record<string, number> = {
  "1:1": 1,
  "9:16": 2,
  "16:9": 3,
  "3:4": 4,
  "4:3": 5,
};

export const SUPPORTED_ASPECTS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;
export type Aspect = (typeof SUPPORTED_ASPECTS)[number];

const RATIOS: Record<Aspect, number> = { "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "16:9": 16 / 9, "9:16": 9 / 16 };

function normalizeAspect(input: string): Aspect | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  const aliases: Record<string, Aspect> = {
    "1:1": "1:1", square: "1:1",
    "4:3": "4:3", landscape: "16:9",
    "3:4": "3:4",
    "16:9": "16:9", wide: "16:9",
    "9:16": "9:16", portrait: "9:16", vertical: "9:16",
  };
  if (aliases[s]) return aliases[s];
  if (/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(s)) {
    const [a, b] = s.split(":").map(Number);
    if (a > 0 && b > 0) return nearestAspect(a / b);
  }
  return null;
}

function nearestAspect(ratio: number): Aspect {
  let best: Aspect = "16:9";
  let bestDistance = Infinity;
  for (const aspect of SUPPORTED_ASPECTS) {
    const d = Math.abs(Math.log(ratio) - Math.log(RATIOS[aspect]));
    if (d < bestDistance) {
      bestDistance = d;
      best = aspect;
    }
  }
  return best;
}

/**
 * Downstream clients send OpenAI-style pixel sizes ("1024x1536") while Flow only
 * accepts five fixed ratios, so map the requested width/height onto the closest
 * supported ratio. An explicit aspect_ratio always wins.
 */
export function aspectFromSize(size?: string, aspectRatio?: string): Aspect {
  if (aspectRatio) {
    const a = normalizeAspect(String(aspectRatio));
    if (a) return a;
  }
  if (!size) return "16:9";
  const s = String(size).trim();
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(s);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return nearestAspect(w / h);
  }
  const named = normalizeAspect(s);
  if (named) return named;
  return "16:9";
}
