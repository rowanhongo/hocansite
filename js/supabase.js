import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let cachedConfig = null;
let cachedClient = null;

const BLOGS_TABLE = "blogs";
const JOBS_TABLE = "jobs";

async function getConfig() {
  if (cachedConfig) return cachedConfig;

  const fallback = {
    supabaseUrl: window.SUPABASE_URL || "",
    supabaseAnonKey: window.SUPABASE_ANON_KEY || ""
  };

  try {
    const res = await fetch("/.netlify/functions/get-config", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not read runtime config");
    const data = await res.json();
    cachedConfig = {
      supabaseUrl: data.supabaseUrl || fallback.supabaseUrl,
      supabaseAnonKey: data.supabaseAnonKey || fallback.supabaseAnonKey,
      cloudinaryCloudName: data.cloudinaryCloudName || "",
      cloudinaryUploadPreset: data.cloudinaryUploadPreset || "",
      adminPassword: data.adminPassword || ""
    };
  } catch (_error) {
    cachedConfig = fallback;
  }

  return cachedConfig;
}

async function getClient() {
  if (cachedClient) return cachedClient;
  const cfg = await getConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error("Supabase is not configured. Check Netlify env vars.");
  }

  cachedClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  return cachedClient;
}

function normalizeBlog(row) {
  return {
    ...row,
    content: Array.isArray(row?.content) ? row.content : []
  };
}

function normalizeJob(row) {
  return {
    ...row,
    requirements: row?.requirements || ""
  };
}

export async function getRuntimeConfig() {
  return getConfig();
}

export async function getPublicBlogs() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(BLOGS_TABLE)
    .select("*")
    .eq("published", true)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data || []).map(normalizeBlog);
}

export async function getPublicBlogBySlug(slug) {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(BLOGS_TABLE)
    .select("*")
    .eq("published", true)
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeBlog(data) : null;
}

export async function getPublicJobs() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .eq("is_active", true)
    .order("posted_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data || []).map(normalizeJob);
}

export async function getPublicJobBySlug(slug) {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .eq("is_active", true)
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeJob(data) : null;
}

export async function adminGetBlogs() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(BLOGS_TABLE)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(normalizeBlog);
}

export async function adminGetBlog(id) {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(BLOGS_TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeBlog(data) : null;
}

export async function adminSaveBlog(payload, id = null) {
  const supabase = await getClient();
  const clean = {
    ...payload,
    updated_at: new Date().toISOString()
  };

  if (id) {
    const { data, error } = await supabase
      .from(BLOGS_TABLE)
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return normalizeBlog(data);
  }

  const { data, error } = await supabase
    .from(BLOGS_TABLE)
    .insert([{ ...clean, created_at: new Date().toISOString() }])
    .select("*")
    .single();
  if (error) throw error;
  return normalizeBlog(data);
}

export async function adminDeleteBlog(id) {
  const supabase = await getClient();
  const { error } = await supabase.from(BLOGS_TABLE).delete().eq("id", id);
  if (error) throw error;
  return true;
}

export async function adminGetJobs() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(normalizeJob);
}

export async function adminGetJob(id) {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeJob(data) : null;
}

export async function adminSaveJob(payload, id = null) {
  const supabase = await getClient();
  const clean = {
    ...payload,
    updated_at: new Date().toISOString()
  };

  if (id) {
    const { data, error } = await supabase
      .from(JOBS_TABLE)
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return normalizeJob(data);
  }

  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .insert([{ ...clean, created_at: new Date().toISOString() }])
    .select("*")
    .single();
  if (error) throw error;
  return normalizeJob(data);
}

export async function adminDeleteJob(id) {
  const supabase = await getClient();
  const { error } = await supabase.from(JOBS_TABLE).delete().eq("id", id);
  if (error) throw error;
  return true;
}
