const API = "https://cs2tracker-production.up.railway.app";

// ─────────────────────────────────────────────
//  REJESTRACJA
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
//  LOGOWANIE
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
//  WATCHLIST — POBIERANIE
// ─────────────────────────────────────────────
async function loadWatchlist() {
  const token = localStorage.getItem("token");

  const res = await fetch(`${API}/api/watchlist`, {
    headers: {
      "Authorization": "Bearer " + token
    }
  });

  // Jeśli nie ma tokena → pokaż modal logowania
if (res.status === 401) {
  const modal = document.getElementById("auth-modal");
  modal.style.display = "flex";
  modal.style.alignItems = "center";
  modal.style.justifyContent = "center";
  return;
}


  const items = await res.json();
  console.log("WATCHLIST:", items);

  // TODO: renderowanie listy
}

// ─────────────────────────────────────────────
//  AUTO-START
// ─────────────────────────────────────────────
window.addEventListener("load", () => {
  loadWatchlist();
});
