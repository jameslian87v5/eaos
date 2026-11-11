import { useCallback } from "react";

const API_BASE = "/api";

export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useAdminApi() {
  const get = useCallback(async (path: string): Promise<any> => {
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return res.json();
  }, []);

  const post = useCallback(async (path: string, body?: any): Promise<any> => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
    return res.json();
  }, []);

  const patch = useCallback(async (path: string, body: any): Promise<any> => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${path}: ${res.status}`);
    return res.json();
  }, []);

  const put = useCallback(async (path: string, body: any): Promise<any> => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PUT ${path}: ${res.status}`);
    return res.json();
  }, []);

  const del = useCallback(async (path: string): Promise<any> => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`DELETE ${path}: ${res.status}`);
    return res.json();
  }, []);

  return { get, post, patch, put, del };
}
