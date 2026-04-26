exports.handler = async function handler() {
  const body = {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    cloudinaryUploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || "",
    adminPassword: process.env.ADMIN_PASSWORD || ""
  };

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
};
