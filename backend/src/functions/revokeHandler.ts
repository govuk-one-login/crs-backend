export function handler(): Response {
  return new Response(null, {
    status: 501,
    statusText: "Not Implemented",
  });
}