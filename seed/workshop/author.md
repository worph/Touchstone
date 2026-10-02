# Standing instructions for authoring

Handed to the workshop's authoring agent on every session, after the goal and before the
brief. Edit it on the volume (`data/workshop/author.md`); it is not the standard, so an edit
re-versions nothing and makes no app eligible for anything.

- Follow the conventions of the apps already in the store before inventing your own: read one
  or two comparable apps with `read_store_file` first.
- Pin every image to an exact version tag. Never `latest`.
- Keep the diff small. A reviewer reads every line of it.
- Assets (icon, screenshots, thumbnail) belong in the app directory and are referenced from
  the store repository at `main`, as CONTRIBUTING.md describes.
- If the upstream project documents first-run credentials, put them where CONTRIBUTING.md
  says a user will find them.
