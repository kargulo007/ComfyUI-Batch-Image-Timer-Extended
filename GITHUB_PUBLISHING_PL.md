# Publikacja projektu na GitHub — gotowe teksty i instrukcja

## Co trafia na GitHub, a co do ComfyUI?

- **GitHub:** wgraj zawartość osobnej paczki `GitHub-REPOSITORY` (wszystkie pliki z folderu repozytorium, nie sam ZIP). Ma kod oraz dokumentację, `.github`, `README.md`, `LICENSE`, `NOTICE.md`, grafikę i `pyproject.toml`.
- **ComfyUI Portable / serwer:** rozpakuj osobną paczkę `ComfyUI-INSTALL` do `ComfyUI/custom_nodes/`, łącząc z istniejącym katalogiem `ComfyUI-Batch-Image-Timer`. Zawiera wyłącznie kod noda, `web/`, licencję, `NOTICE.md` i metadane pakietu.
- **Dane:** nie zastępuj ani nie usuwaj katalogu `data/` zawierającego SQLite i ustawienia. Żadna z paczek nie zawiera Twojej bazy.
- **Uwaga:** nie trzymaj jednocześnie dwóch kopii noda w `custom_nodes` (starej i Extended), ponieważ mogą rejestrować tę samą klasę.

## 1. Dane repozytorium do skopiowania

**Repository name:** `ComfyUI-Batch-Image-Timer-Extended`

**Description / About (EN):**
`Advanced ComfyUI generation timer with image history, analytics, GPU/VRAM monitoring, SQLite statistics and workflow recall.`

**Topics (wpisuj bez #, oddzielnie):**
`comfyui`, `comfyui-custom-nodes`, `comfyui-nodes`, `image-generation`, `ai-art`, `generation-timer`, `gpu-monitor`, `vram`, `sqlite`, `generation-history`, `stable-diffusion`, `workflow`

**Visibility:** Public (jeśli chcesz udostępnić dodatek innym)

**Author / Maintainer:** Piotr Karwowski (Extended edition)

**License:** MIT (wspólna licencja zawierająca copyright Hermana Kwana dla kodu źródłowego oraz Piotra Karwowskiego dla rozszerzeń)

**Default branch:** main

**Website:** zostaw puste, dopóki nie utworzysz osobnej strony produktu.

**Suggested release tag:** `v1.9.2`

**Release title:** `v1.9.2 — Generation Monitor Extended | GPU, Analytics & History`

**Release description:** patrz `docs/RELEASE_NOTES_v1.9.2.md`.

## 2. Utwórz repozytorium

1. Zaloguj się na github.com i wybierz **New repository**.
2. Wklej nazwę oraz opis z punktu 1. Wybierz **Public**.
3. **Nie zaznaczaj** automatycznego dodawania README, `.gitignore` ani licencji — już są gotowe.
4. Utwórz repozytorium.
5. Wgraj zawartość folderu z tej paczki (pliki `README.md`, `__init__.py`, katalog `web` itd.). Nie wgrywaj samego ZIP-a zamiast rozpakowanych plików.
6. Zatwierdź commit, np. `Initial Extended v1.9.2 public release`.
7. GitHub wyrenderuje automatycznie `README.md` jako stronę główną repozytorium.
8. W sekcji **About** dodaj wszystkie Topics.
9. Wejdź w **Releases → Draft a new release** i utwórz tag `v1.9.2`, tytuł i opis według pliku Release Notes.
10. Możesz załączyć osobny ZIP instalacyjny; GitHub i tak udostępni ZIP źródeł dla każdego wydania.

## 3. Konieczna personalizacja przed publikacją

`pyproject.toml` celowo **nie zawiera** PublisherId `hermankwan` ani oryginalnego URL repo. Po poznaniu swojego adresu:
- włącz w `pyproject.toml` sekcję `[project.urls]` i wpisz **własny** URL GitHub;
- jeśli chcesz trafić do ComfyUI Manager/Registry, utwórz i zweryfikuj **własny** PublisherId, wtedy dopiero dodaj `[tool.comfy]` z nim;
- podmień `YOUR_USERNAME` w sekcji instalacji `README.md` na nazwę swojego konta.

Nie ustawiaj oryginalnego PublisherId ani nie przedstawiaj wydania jako oficjalnej aktualizacji Hermana Kwana.

**Copyright:** w LICENSE oraz nagłówkach części oryginalnych plików kodu znajduje się `Copyright (c) 2026 Herman Kwan`. Wymaga on zachowania przy redystrybucji kodu na MIT. Nie zastępuj go swoją nazwą. W rozszerzonej wersji dopisano `Copyright (c) 2026 Piotr Karwowski` do nowych i zmodyfikowanych elementów oraz LICENSE. Oryginalna linia `Copyright (c) 2026 Herman Kwan` pozostaje — obowiązek licencji MIT. Szczegóły w `NOTICE.md` i `docs/COPYRIGHT_AUDIT.md`.

## 4. Materiały graficzne

W `assets/interface-preview-earlier-build.png` jest dostarczony przez Ciebie zrzut działającej wcześniejszej wersji. W README jest prawidłowo opisany jako wcześniejszy podgląd. Najlepiej później zastąpić go aktualnym zrzutem v1.9.2 ze wszystkimi sekcjami, usuwając podpis "earlier build".

Zalecany dodatkowy materiał: krótki GIF z uruchomieniem renderowania, paskiem postępu, otwarciem historii i GPU Monitor. Nie jest wymagany do działania repozytorium.

## 5. Co robi repozytorium, a czego jeszcze nie robi

Publikacja na GitHub nie rejestruje automatycznie noda w ComfyUI Manager. Do dystrybucji w Registry potrzebny jest osobny proces oraz własny publisher. Póki co polecana jest ręczna instalacja.

## 6. Gotowy krótki post informacyjny (EN)

Introducing **ComfyUI Batch Image Timer Extended v1.9.2** — a community extension of Herman Kwan's MIT-licensed Batch Image Timer. Track generation time, revisit image prompts and workflows, analyze SQLite-backed daily and monthly results, monitor supported GPU/VRAM metrics, and explore output-storage statistics directly from ComfyUI. The node provides an optional GPU panel and dedicated Settings, Failures, Analytics and Monitor popups. Installation and documentation are available in this repository.

## 7. Gotowy opis po polsku

**ComfyUI Batch Image Timer Extended** to rozszerzony node monitorujący czas generowania obrazów. Oferuje historię ostatnich renderowań, podgląd grafik i promptów, możliwość ponownego otwarcia workflow, trwałe statystyki SQLite, wykresy, analizę wydajności, powiadomienia oraz opcjonalny monitor GPU i VRAM. Projekt stanowi niezależne rozwinięcie oryginalnego dodatku Hermana Kwana (licencja MIT).
