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

  // Determine resource type based on file extension
  const fileName = file.name.toLowerCase();
  const isPdf = fileName.endsWith('.pdf');
  const isDocx = fileName.endsWith('.docx');
  const isImage = fileName.match(/\.(jpg|jpeg|png)$/i);

  if (!isPdf && !isDocx && !isImage) {
    throw new Error("Invalid file type. Please upload a PDF, DOCX, or image file.");
  }

  // Use 'raw' for PDF/DOCX, 'image' for images
  const resourceType = isPdf || isDocx ? 'raw' : 'image';
  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourceType}/upload`;

  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", uploadPreset);
  form.append("type", "upload");
  form.append("resource_type", resourceType);
  if (options.folder) form.append("folder", options.folder);

  // Format file size in MB for error messages
  function formatFileSize(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb.toFixed(2) + ' MB';
  }

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
        let msg = body.error?.message || "Cloudinary upload failed";
        // Format file size errors to show MB
        if (msg.includes('Got') && msg.includes('Maximum')) {
          msg = msg.replace(/Got (\d+)/, (match, bytes) => `Got ${formatFileSize(parseInt(bytes))}`)
                   .replace(/Maximum is (\d+)/, (match, bytes) => `Maximum is ${formatFileSize(parseInt(bytes))}`);
        }
        reject(new Error(msg));
        return;
      }
      resolve({
        url: body.secure_url,
        publicId: body.public_id,
        originalFilename: body.original_filename || file.name,
        width: body.width,
        height: body.height,
        format: body.format,
        resourceType: body.resource_type
      });
    };

    xhr.onerror = () => reject(new Error("Network error while uploading file"));
    xhr.send(form);
  });
}
