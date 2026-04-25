const PROJECT_ID = "ktbj8t65";
const DATASET = "production";
const API_VERSION = "v2023-01-01";

async function sanityFetch(query, params = {}) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://${PROJECT_ID}.api.sanity.io/${API_VERSION}/data/query/${DATASET}?query=${encodedQuery}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({params}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sanity query failed (${res.status}): ${text || res.statusText}`);
  }

  const data = await res.json();
  return data.result;
}

export async function getBlogPosts() {
  return sanityFetch(
    `*[_type=="blogPost"]|order(_createdAt desc){
      _id,
      title,
      "slug": slug.current,
      excerpt,
      coverImage,
      _createdAt
    }`
  );
}

export async function getBlogPost(slug) {
  return sanityFetch(
    `*[_type=="blogPost" && slug.current==$slug][0]{
      _id,
      title,
      "slug": slug.current,
      excerpt,
      coverImage,
      content,
      _createdAt
    }`,
    {slug}
  );
}

export async function getJobPosts() {
  return sanityFetch(
    `*[_type=="jobPost"]|order(_createdAt desc){
      _id,
      title,
      location,
      jobType,
      _createdAt
    }`
  );
}

