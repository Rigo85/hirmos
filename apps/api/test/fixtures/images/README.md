# Image fixtures

`navidrome-artist-placeholder.webp` and `navidrome-album-placeholder.webp` are
unchanged static resources from Navidrome v0.63.2 (GPL-3.0):

- https://github.com/navidrome/navidrome/blob/v0.63.2/resources/artist-placeholder.webp
- https://github.com/navidrome/navidrome/blob/v0.63.2/resources/album-placeholder.webp
- https://github.com/navidrome/navidrome/blob/v0.63.2/LICENSE

SHA-256, respectively:

```
521259c652af6d43cb124876106258d93b6b6f7fbe7ad2c73e8345875afe4dcf
273a4dbd61dfbb0a12d5d8ffe780eb7a3d4d000bc9771c5411cc70ae4dfa8a1f
```

The provider's `GetOrPlaceholder` returns these static resources when artwork
is unavailable, regardless of the requested size. Tests use the actual bytes,
without mocking classification. Other test images are generated synthetic PNGs.
