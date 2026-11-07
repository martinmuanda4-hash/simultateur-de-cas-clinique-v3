# Cas Zéro – Simulateur de cas cliniques (PWA)

Application statique (HTML/CSS/JS pur, sans build) qui fait jouer un cas clinique à un étudiant en médecine.

## Structure

- `index.html`, `styles.css`, `app.js` : l'application (logique en anglais)
- `data/cas-zero-medecine-interne.json` : tout le contenu français (cas, libellés, messages)
- `manifest.webmanifest`, `sw.js`, `icons/` : couche PWA (installable, fonctionne hors ligne)

## Tester en local

```bash
npx serve .
```

Ouvrez l'adresse affichée. L'application doit passer par un serveur (le fichier JSON est chargé avec `fetch`).

## Déployer (GitHub + Vercel)

```bash
git init
git add .
git commit -m "Premier simulateur: cas méningite / paludisme"
git branch -M main
git remote add origin https://github.com/VOTRE-COMPTE/VOTRE-DEPOT.git
git push -u origin main
```

Dans Vercel : *Add New > Project*, importez le dépôt GitHub, framework « Other », aucun build à configurer. Chaque `git push` redéploie le site.

## Ajouter un nouveau cas

Dupliquez le fichier JSON, changez le contenu, puis modifiez `DATA_URL` dans `app.js`. Pensez à incrémenter `CACHE_NAME` dans `sw.js` après chaque modification.

## Règles de score

- Score de départ 100, plafonné à 100, minimum 0
- « Besoin d'aide ? » : -2 (une fois par étape)
- Examen neurologique oublié : -10
- Examen inutile : -10
- Diagnostic trouvé : +10 chacun
- Erreur fatale (sédatifs, ignorer la PL) : -30
