import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let cachedConfig = null;
let cachedClient = null;
const RUNTIME_CONFIG_CACHE_KEY = "hocan_runtime_config_v1";

const BLOGS_TABLE_CANDIDATES = ["blog_posts", "blogs"];
const JOBS_TABLE_CANDIDATES = ["job_posts", "jobs"];
const APPLICATIONS_TABLE_CANDIDATES = ["job_applications"];
let resolvedBlogsTable = null;
let resolvedJobsTable = null;
let resolvedApplicationsTable = null;

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

async function resolveTable(candidates) {
  const supabase = await getClient();
  for (const table of candidates) {
    const { error } = await supabase.from(table).select("id").limit(1);
    if (!error) return table;
  }
  throw new Error(`No valid table found. Tried: ${candidates.join(", ")}`);
}

async function blogQuery() {
  const supabase = await getClient();
  if (!resolvedBlogsTable) resolvedBlogsTable = await resolveTable(BLOGS_TABLE_CANDIDATES);
  const table = resolvedBlogsTable;
  return supabase.from(table);
}

async function jobQuery() {
  const supabase = await getClient();
  if (!resolvedJobsTable) resolvedJobsTable = await resolveTable(JOBS_TABLE_CANDIDATES);
  const table = resolvedJobsTable;
  return supabase.from(table);
}

async function applicationQuery() {
  const supabase = await getClient();
  if (!resolvedApplicationsTable) {
    resolvedApplicationsTable = await resolveTable(APPLICATIONS_TABLE_CANDIDATES);
  }
  const table = resolvedApplicationsTable;
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

function normalizeApplication(row) {
  return {
    ...row,
    previous_experience: Array.isArray(row?.previous_experience) ? row.previous_experience : []
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
  // Important: supabase-js query builders are mutable; reusing the same builder
  // after a failed select can keep stale params. Caller should pass a fresh query
  // when retrying. As a fallback, we retry on a fresh builder when possible.
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
  console.log("FETCHING JOBS FROM SUPABASE");
  try {
    const query = await jobQuery();
    const { data, error } = await query
      .select("id,title,slug,location,job_type,industry,description,experience,salary,posted_at,created_at,is_active")
      .eq("is_active", true)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(normalizeJob);
  } catch (err) {
    console.log("Supabase error:", err);
    const query = await jobQuery();
    const { data, error } = await query
      .select("id,title,slug,location,job_type,industry,description,posted_at,created_at,is_active")
      .eq("is_active", true)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(normalizeJob);
  }
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
  const { data: jobRow } = await query
    .select("id,slug,title")
    .eq("id", id)
    .maybeSingle();

  if (jobRow?.id || jobRow?.slug || jobRow?.title) {
    const appQuery = await applicationQuery();
    const clauses = [];
    if (jobRow.id) clauses.push(`job_id.eq.${jobRow.id}`);
    if (jobRow.slug) clauses.push(`job_slug.eq.${jobRow.slug}`);
    if (jobRow.title) clauses.push(`job_title.eq.${jobRow.title}`);
    if (clauses.length) {
      const { error: appDeleteError } = await appQuery
        .delete()
        .or(clauses.join(","));
      if (appDeleteError) throw appDeleteError;
    }
  }

  const { error } = await query.delete().eq("id", id);
  if (error) throw error;
  return true;
}

export async function adminDeleteApplication(id) {
  const query = await applicationQuery();
  const { error } = await query
    .delete()
    .eq("id", id);
  if (error) throw error;
  return true;
}

export async function adminDeleteApplicationsByJobTitle(jobTitle) {
  const title = String(jobTitle || "").trim();
  if (!title) return 0;

  const query = await applicationQuery();
  const { error } = await query
    .delete()
    .eq("job_title", title);
  if (error) throw error;
  return true;
}

export async function submitJobApplication(payload) {
  const query = await applicationQuery();
  const clean = {
    ...payload,
    previous_experience: Array.isArray(payload?.previous_experience)
      ? payload.previous_experience.slice(0, 3).map((v) => String(v || "").trim()).filter(Boolean)
      : [],
    created_at: new Date().toISOString()
  };

  const { data, error } = await query
    .insert([clean])
    .select("*")
    .single();
  if (error) throw error;
  return normalizeApplication(data);
}

export async function adminGetApplications() {
  const query = await applicationQuery();
  const { data, error } = await query
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(normalizeApplication);
}

export async function uploadCvToSupabase(file) {
  const supabase = await getClient();
  const ext = file.name.split('.').pop();
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const path = `applications/${filename}`;

  const { data, error } = await supabase.storage
    .from('CV')
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type
    });

  if (error) throw new Error(error.message);

  const { data: urlData } = supabase.storage
    .from('CV')
    .getPublicUrl(path);

  return {
    url: urlData.publicUrl,
    filename: file.name,
    path: path
  };
}

export async function deleteCvFromSupabase(path) {
  const supabase = await getClient();
  const { error } = await supabase.storage
    .from('CV')
    .remove([path]);
  if (error) throw new Error(error.message);
}
