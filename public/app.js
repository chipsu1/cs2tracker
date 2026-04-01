const API = "https://cs2tracker-production.up.railway.app";

async function register() {
  const email = document.getElementById("auth-email").value;
  const password = document.getElementById("auth-password").value;

  const res = await fetch(`${API}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();
  if (data.token) {
    localStorage.setItem("token", data.token);
    location.reload();
  } else {
    alert("Błąd rejestracji");
  }
}

async function login() {
  const email = document.getElementById("auth-email").value;
  const password = document.getElementById("auth-password").value;

  const res = await fetch(`${API}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();
  if (data.token) {
    localStorage.setItem("token", data.token);
    location.reload();
  } else {
    alert("Błędne dane logowania");
  }
}
