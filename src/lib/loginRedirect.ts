export function isLoginRedirect(response: Response): boolean {
  if (response.status !== 302) {
    return false;
  }
  const location = response.headers.get("location") ?? "";
  return (
    location.includes("/Account/Login") || location.includes("Login.aspx")
  );
}
