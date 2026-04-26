import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let cachedConfig = null;
let cachedClient = null;
const RUNTIME_CONFIG_CACHE_KEY = "hocan_runtime_config_v1";
const TABLE_CACHE_KEY = "hocan_table_cache_v1";

const BLOGS_TABLE_CANDIDATES = ["blog_posts", "blogs"];
const JOBS_TABLE_CANDIDATES = ["job_posts", "jobs"];
let resolvedBlogsTable = null;
let resolvedJobsTable = null;

async function getConfig() {
  if (cachedConfig) return cachedConfig;

  const fallback = {
    supabaseUrl: window.SUPABASE_URL || "",
    supabaseAnonKey: window.SUPABASE_ANON_KEY || ""
  };

  try {
    const fromStorage = sessionStorage.getItem(RUNTIME_CONFIG_CACHE_KEY);
    if (fromStorage) {
      cachedConfig = JSON.parse(fromStorage);
      return cachedConfig;
    }
  } catch (_e) {
    // ignore storage parse failures
  }

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

  try {
    sessionStorage.setItem(RUNTIME_CONFIG_CACHE_KEY, JSON.stringify(cachedConfig));
  } catch (_e) {
    // ignore storage write failures
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

async function resolveTable(candidates, cacheKey) {
  try {
    const fromStorage = JSON.parse(sessionStorage.getItem(TABLE_CACHE_KEY) || "{}");
    if (cacheKey === "blogs" && fromStorage.blogs) resolvedBlogsTable = fromStorage.blogs;
    if (cacheKey === "jobs" && fromStorage.jobs) resolvedJobsTable = fromStorage.jobs;
  } catch (_e) {
    // ignore
  }

  if (cacheKey === "blogs" && resolvedBlogsTable) return resolvedBlogsTable;
  if (cacheKey === "jobs" && resolvedJobsTable) return resolvedJobsTable;

  const supabase = await getClient();

  for (const table of candidates) {
    const { error } = await supabase.from(table).select("id", { count: "exact", head: true });
    if (!error) {
      if (cacheKey === "blogs") resolvedBlogsTable = table;
      if (cacheKey === "jobs") resolvedJobsTable = table;
      try {
        const current = JSON.parse(sessionStorage.getItem(TABLE_CACHE_KEY) || "{}");
        current[cacheKey] = table;
        sessionStorage.setItem(TABLE_CACHE_KEY, JSON.stringify(current));
      } catch (_e) {
        // ignore
      }
      return table;
    }
  }

  throw new Error(`No usable table found. Tried: ${candidates.join(", ")}`);
}

async function blogQuery() {
  const supabase = await getClient();
  const table = await resolveTable(BLOGS_TABLE_CANDIDATES, "blogs");
  return supabase.from(table);
}

async function jobQuery() {
  const supabase = await getClient();
  const table = await resolveTable(JOBS_TABLE_CANDIDATES, "jobs");
  return supabase.from(table);
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

async function safeSelect(query, selectA, selectB) {
  const first = await query.select(selectA);
  if (!first.error) return first;

  const msg = String(first.error?.message || "").toLowerCase();
  // Supabase REST returns 400 for unknown columns in select()
  const isColumnError =
    msg.includes("column") ||
    msg.includes("parse") ||
    msg.includes("unknown") ||
    msg.includes("failed to parse") ||
    msg.includes("bad request") ||
    msg.includes("schema cache") ||
    msg.includes("could not find the") ||
    first.error?.code === "PGRST204";

  if (!isColumnError || !selectB) throw first.error;
  const second = await query.select(selectB);
  if (second.error) throw second.error;
  return second;
}

export async function getRuntimeConfig() {
  return getConfig();
}

export async function getPublicBlogs() {
  const query = await blogQuery();
  const { data, error } = await query
    .select("id,title,slug,category,author,excerpt,cover_image_url,published,published_at,created_at")
    .eq("published", true)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data || []).map(normalizeBlog);
}

export async function getPublicBlogBySlug(slug) {
  const query = await blogQuery();
  const { data, error } = await query
    .select("*")
    .eq("published", true)
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeBlog(data) : null;
}

export async function getPublicJobs() {
  const base = await jobQuery();
  const query = base
    .eq("is_active", true)
    .order("posted_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  const { data } = await safeSelect(
    query,
    "id,title,slug,location,job_type,industry,description,experience,salary,city,country,posted_at,created_at,is_active",
    "id,title,slug,location,job_type,industry,description,posted_at,created_at,is_active"
  );

  return (data || []).map(normalizeJob);
}

export async function getPublicJobBySlug(slug) {
  const query = await jobQuery();
  const { data, error } = await query
    .select("*")
    .eq("is_active", true)
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  return data ? normalizeJob(data) : null;
}

export async function adminGetBlogs() {
  const query = await blogQuery();
  const { data, error } = await query
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(normalizeBlog);
}

export async function adminGetBlog(id) {
  const query = await blogQuery();
  const { data, error } = await query
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeBlog(data) : null;
}

export async function adminSaveBlog(payload, id = null) {
  const query = await blogQuery();
  const clean = {
    ...payload,
    updated_at: new Date().toISOString()
  };

  if (id) {
    const { data, error } = await query
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return normalizeBlog(data);
  }

  const { data, error } = await query
    .insert([{ ...clean, created_at: new Date().toISOString() }])
    .select("*")
    .single();
  if (error) throw error;
  return normalizeBlog(data);
}

export async function adminDeleteBlog(id) {
  const query = await blogQuery();
  const { error } = await query.delete().eq("id", id);
  if (error) throw error;
  return true;
}

export async function adminGetJobs() {
  const query = await jobQuery();
  const { data, error } = await query
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(normalizeJob);
}

export async function adminGetJob(id) {
  const query = await jobQuery();
  const { data, error } = await query
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeJob(data) : null;
}

export async function adminSaveJob(payload, id = null) {
  const query = await jobQuery();
  const clean = {
    ...payload,
    updated_at: new Date().toISOString()
  };

  if (id) {
    const { data, error } = await query
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw error;
    return normalizeJob(data);
  }

  const { data, error } = await query
    .insert([{ ...clean, created_at: new Date().toISOString() }])
    .select("*")
    .single();
  if (error) throw error;
  return normalizeJob(data);
}

export async function adminDeleteJob(id) {
  const query = await jobQuery();
  const { error } = await query.delete().eq("id", id);
  if (error) throw error;
  return true;
}
