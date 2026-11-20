# Rewind mascot production asset

Saved asset: `apps/desktop/src/renderer/assets/rewind-mascot.png`.

Created with the built-in ImageGen tool using the two user-supplied Rewind reference images. Output is 1254 × 1254, 32-bit ARGB, 1,048,644 bytes. Genuine transparency was checked (corner alpha 0, center alpha 253), and the actual saved PNG and 40/74-pixel app uses were visually inspected. It is an original UI asset derived from the supplied art direction, not a screenshot used as a component. No runtime image-generation service, external fetch, text, microphone or accessories are included.

The reusable `Mascot` component uses this asset for idle/recording, with restrained working/thinking and one-shot acknowledged-success motion. Ordinary recording does not run an animation loop. Reduced-motion preferences disable mascot and panel animation. There is no listening state because voice input is unsupported.

Exact generation prompt:

> Use case: stylized-concept
>
> Asset type: production desktop UI mascot, single transparent PNG cutout, square 1024x1024.
>
> Input images: Image 1 is a character/material reference for the glossy blue/lavender Rewind loop-arrow mascot. Image 2 is a readability and minimal face reference for the small notch companion. They are references only; do not reproduce their interface or text.
>
> Primary request: Create one cute, polished 3D rewind-arrow mascot. The primary shape is a thick soft rounded arrow curving into one open loop, with a generous simple arrowhead facing left to communicate rewind. Use a very simple, unmistakable silhouette readable at 40 pixels. Add two tiny expressive dark glossy oval eyes with white highlights and a tiny subtle happy smile on the broad arrowhead. No limbs. Blue and lavender gradients, soft pearly highlights, slightly translucent glossy molded material, gentle studio lighting.
>
> Composition: isolated whole mascot centered in square frame, approximately 8% clear margin on every side, front three-quarter view with little perspective, large simple silhouette. Genuine fully transparent background with clean antialiased alpha edges. No cast ground shadow outside silhouette.
>
> Constraints: one mascot only; no words, letters, numbers, accessories, computer, laptop, panels, scene, rectangular ground, background, watermark, UI, sparkles, detached ornament or duplicate views.

The tool returned a larger square than the requested nominal size. The original alpha PNG is retained; production display size is set by the component stylesheet.
