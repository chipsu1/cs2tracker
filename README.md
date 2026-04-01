# CS2 Steam Price Tracker — Railway Deploy

Aplikacja do śledzenia cen skórek CS2 na Steam Market.
Hostowana na Railway — zero instalacji, działa online.

---

## 🚀 Jak wdrożyć na Railway (5 minut, za darmo)

### Krok 1 — Utwórz konto GitHub
Wejdź na https://github.com i zarejestruj się (jeśli nie masz).

### Krok 2 — Wgraj pliki na GitHub
1. Wejdź na https://github.com/new
2. Nazwa repozytorium: `cs2tracker`
3. Kliknij **Create repository**
4. Kliknij **uploading an existing file**
5. Wgraj WSZYSTKIE pliki z tego folderu:
   - `server.js`
   - `package.json`
   - `railway.json`
   - `.gitignore`
   - folder `public/` z plikiem `index.html`
6. Kliknij **Commit changes**

### Krok 3 — Wdróż na Railway
1. Wejdź na https://railway.app
2. Zaloguj się przez GitHub
3. Kliknij **New Project → Deploy from GitHub repo**
4. Wybierz repozytorium `cs2tracker`
5. Railway automatycznie wykryje Node.js i uruchomi aplikację
6. Po chwili pojawi się zielony link, np. `https://cs2tracker-production.up.railway.app`

### To wszystko! 🎉
Pod tym linkiem działa Twoja aplikacja — wchodzisz z dowolnego urządzenia.

---

## Uwagi

- **Darmowy plan Railway**: 500h/miesiąc — wystarczy na ciągłe działanie
- **Dane**: przechowywane w `/tmp` (reset przy restarcie serwera).
  Dla trwałych danych dodaj Railway Volume w ustawieniach projektu i ustaw zmienną środowiskową `DATA_DIR=/data`
- **Ceny**: pobierane co 1 godzinę automatycznie, plus ręcznie na żądanie
- **Steam rate limit**: 3 sekundy między requestami — nie obejdziesz tego

## Struktura

```
cs2tracker/
├── server.js          # backend + proxy Steam
├── package.json       # zależności Node.js
├── railway.json       # konfiguracja Railway
├── .gitignore
└── public/
    └── index.html     # cały frontend
```
