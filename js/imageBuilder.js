const projectId = "ktbj8t65";
const dataset = "production";

function parseAssetRef(ref) {
  // Example: "image-<assetId>-<w>x<h>-<format>"
  const parts = String(ref || "").split("-");
  if (parts[0] !== "image" || parts.length < 4) return null;
  const id = parts[1];
  const dims = parts[2]; // "2000x1333"
  const format = parts.slice(3).join("-"); // "jpg" (or "jpeg", "png", "webp", etc.)
  const [width, height] = dims.split("x").map((n) => Number(n));
  if (!id || !width || !height || !format) return null;
  return {id, width, height, format};
}

export function urlFor(image) {
  const ref = image?.asset?._ref;
  const parsed = parseAssetRef(ref);
  let targetWidth = null;

  const builder = {
    width(w) {
      targetWidth = Number(w) || null;
      return builder;
    },
    url() {
      if (!parsed) return "";
      const base = `https://cdn.sanity.io/images/${projectId}/${dataset}/${parsed.id}-${parsed.width}x${parsed.height}.${parsed.format}`;
      if (targetWidth) return `${base}?w=${encodeURIComponent(String(targetWidth))}&auto=format`;
      return `${base}?auto=format`;
    },
  };

  return builder;
}

