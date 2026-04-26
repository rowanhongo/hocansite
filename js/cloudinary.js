import { getRuntimeConfig } from "./supabase.js";

export async function uploadToCloudinary(file, options = {}) {
  if (!(file instanceof File)) {
    throw new Error("Please select a valid file");
  }

  const cfg = await getRuntimeConfig();
  const cloudName = cfg.cloudinaryCloudName;
  const uploadPreset = cfg.cloudinaryUploadPreset;

  if (!cloudName || !uploadPreset) {
    throw new Error("Cloudinary is not configured. Check Netlify env vars.");
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`;
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", uploadPreset);
  if (options.folder) form.append("folder", options.folder);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint);
    xhr.responseType = "json";

    if (typeof options.onProgress === "function") {
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const pct = Math.round((event.loaded / event.total) * 100);
        options.onProgress(pct);
      };
    }

    xhr.onload = () => {
      const ok = xhr.status >= 200 && xhr.status < 300;
      const body = xhr.response || {};
      if (!ok || !body.secure_url) {
        const msg = body.error?.message || "Cloudinary upload failed";
        reject(new Error(msg));
        return;
      }
      resolve({
        url: body.secure_url,
        publicId: body.public_id,
        width: body.width,
        height: body.height,
        format: body.format
      });
    };

    xhr.onerror = () => reject(new Error("Network error while uploading image"));
    xhr.send(form);
  });
}
