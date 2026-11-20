# Hello Sigil

A tiny web app that uses Sign in with Sigil: it asks for read access to a vault, lists the folders the person allowed, searches them and reads one memory. Everything is decrypted in the browser tab; the app's server (here, a static file server) never sees a memory.

```sh
npm run build -w @sigil/sdk
node examples/hello-sigil/serve.mjs      # http://127.0.0.1:5180
```

Open it, enter the address of your Sigil site and choose Sign in with Sigil. A window from your vault opens: unlock it, pick the folders, and allow. The app receives an app key made for it alone. It shows up in your vault under Apps, where you can change its folders or revoke it, and each read it makes is in your read log.

The example keeps the key in the tab's session storage, so it is gone when the tab closes. Your own app decides where to keep it; treat it like a password.
