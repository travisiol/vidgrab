# vidgrab

Télécharge les vidéos d'une page, ou de tout un site. Interface web locale + ligne de commande.

## Installation

```bash
npm install          # installe aussi yt-dlp (bin/) et ffmpeg (ffmpeg-static)
npm start            # → http://localhost:3787
```

Chrome ou Edge doit être installé pour le mode navigateur (sinon `VIDGRAB_BROWSER=chemin/vers/chrome`).

## Comment il trouve les vidéos

Pour chaque URL, dans l'ordre :

1. **yt-dlp** : si le site a un extracteur dédié (YouTube, Vimeo, TikTok, X, Twitch, Dailymotion, archive.org… ≈1 800 sites),
   il gère tout, playlists et chaînes comprises.
2. **HTML statique** : `<video>`/`<source>`, liens `.mp4/.webm/.m3u8/.mpd`, `og:video`, JSON-LD `VideoObject`,
   configs de lecteurs dans les scripts, iframes de lecteurs connus.
3. **Navigateur invisible** (Chrome/Edge local via Playwright) : charge la page, lance les lecteurs, et capture
   les requêtes `.m3u8` / `.mpd` / `video/*`. C'est ce qui attrape les lecteurs JavaScript (hls.js, video.js, SPA).

**Plusieurs liens d'un coup** : colle-les dans le champ (un par ligne, Maj+Entrée pour aller à la ligne). Chaque lien
devient une tâche, toutes lancées en même temps. Au total, 6 téléchargements tournent au maximum en parallèle
(`VIDGRAB_MAX_DOWNLOADS` pour changer), le navigateur invisible est partagé, et deux liens qui mènent à la même
vidéo ne la téléchargent qu'une fois.

Dans l'interface, « Téléchargement » propose : tout automatiquement, **par lots** (les N premières partent,
puis le bouton « Les N suivantes »), ou lister seulement (chaque vidéo a son bouton).

Les flux HLS/DASH sont assemblés en `.mp4` par ffmpeg. Les variantes d'une même playlist HLS sont regroupées,
les pubs vidéo (régies connues, VAST/VPAID) sont ignorées.

En mode **Tout le site**, il parcourt les pages du même domaine (robots.txt respecté par défaut, pages max et profondeur réglables,
filtres regex inclure/exclure) et applique la même chaîne à chaque page.

## Ligne de commande

```bash
node src/cli.js https://exemple.com/video/123
node src/cli.js https://exemple.com --site --max-pages 500 --include "/videos/"
node src/cli.js https://exemple.com --site --list        # liste sans télécharger
node src/cli.js https://exemple.com/page --batch 5       # 5 par 5 : Entrée = lot suivant
node src/cli.js https://a.com/v/1 https://b.com/page     # plusieurs liens en même temps
node src/cli.js --file liens.txt                         # un lien par ligne
node src/cli.js --help
```

Sous Git Bash, préfixe avec `MSYS_NO_PATHCONV=1` quand une regex commence par `/` (sinon Bash la transforme en chemin Windows).

## Fichiers

- `downloads/<domaine>/` : les vidéos
- `downloads/.vidgrab/` : archives des téléchargements (une vidéo déjà récupérée n'est pas re-téléchargée)

## Limites

- Pas de contournement de DRM : Netflix, Disney+, Prime Video, Canal+, etc. sont refusés d'emblée.
- Pas de contournement de paywall ou de captcha. Pour un site où tu as un compte : option « Cookies du navigateur »
  (Firefox recommandé ; Chrome chiffre ses cookies depuis la v127) ou `--cookies cookies.txt`.
- yt-dlp casse quand les sites changent : bouton « Mettre à jour yt-dlp » dans l'interface, ou `npm run setup`.
