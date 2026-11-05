// =====================================================================
//  Mona Lisa cube world, in WebGL
//
//  - The ground is a grid of cubes, one per pixel of the Mona Lisa.
//    Each cube takes its COLOR from the color image and its HEIGHT
//    from the greyscale image (brighter pixel = taller cube).
//  - The sky block is covered in a repeating drawing of Leonardo da
//    Vinci's flying machine, and flies back and forth along a Bezier
//    curve on its own.
// =====================================================================
//
// THE BIG PICTURE
// ---------------
// WebGL can only draw points, lines and triangles. To draw a cube we
// describe it as 12 triangles (2 per face × 6 faces), hand those
// triangles to the GPU, and then ask the GPU to draw that cube many
// times, each time with a different position, height and color.
//
// Every frame of WebGL drawing follows the same basic steps:
//
//   1. SHADERS  - small programs that run on the GPU. The *vertex shader*
//                 decides where each corner (vertex) of a triangle lands
//                 on the screen. The *fragment shader* decides the color
//                 of each pixel inside the triangle.
//   2. BUFFERS  - we copy our vertex data (the corners of the cube) into
//                 GPU memory once, at startup.
//   3. UNIFORMS - values that stay the same for a whole draw call, like
//                 the camera, or where the sky block is.
//   4. DRAW     - we tell the GPU "draw 36 vertices as triangles".
//
// This scene uses TWO shader programs:
//   terrainProgram  - draws every ground cube in ONE draw call (instancing)
//   skyBlockProgram - draws the sky block with a texture on it
//
// The sections below follow that same order.


// ---------------------------------------------------------------------
// 0. Get a WebGL "context" from the <canvas> element in index.html.
//    The context (gl) is the object we use to issue every WebGL command.
// ---------------------------------------------------------------------
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl');

// INSTANCING
// The Mona Lisa is 400 × 482 pixels, which is about 193,000 cubes. With
// one draw call per cube, a single frame takes around a second, so the
// sky block could never fly smoothly: draw() runs every animation frame.
//
// "Instanced drawing" fixes this: we upload every cube's position,
// height and color into a buffer ONCE, then say "draw the cube 193,000
// times" in a SINGLE call. The GPU walks through that buffer itself,
// one entry per copy (per "instance").
//
// In WebGL 1 instancing comes from an extension that every modern
// browser supports.
const instancing = gl.getExtension('ANGLE_instanced_arrays');
if (!instancing) {
  throw new Error('This browser does not support ANGLE_instanced_arrays');
}


// ---------------------------------------------------------------------
// 1. SHADERS
//    Shaders are written in GLSL, a C-like language. We store the source
//    code in JavaScript strings, then compile them for the GPU.
//
//    Three kinds of shader variables:
//      attribute - a different value for every vertex (e.g. its position)
//                  or, with instancing, for every cube copy
//      uniform   - one value shared by every vertex in a draw call
//      varying   - passed from the vertex shader to the fragment shader
// ---------------------------------------------------------------------

// ---- 1a. Terrain shaders (the ground cubes) ------------------------
const terrainVertexSource = /* glsl */ `
  attribute vec3 aPosition;   // corner position of the cube (model space)
  attribute vec3 aNormal;     // direction the face is pointing

  // Per-INSTANCE attributes: these change once per cube, not per vertex.
  attribute vec2 aOffset;     // where this cube sits on the ground (x, z)
  attribute float aHeight;    // how tall this cube is
  attribute vec3 aColor;      // this cube's color (red, green, blue: 0..1)

  uniform mat4 uView;         // where the camera is and where it looks
  uniform mat4 uProjection;   // perspective: far things look smaller

  varying vec3 vNormal;       // handed to the fragment shader
  varying vec3 vColor;

  void main() {
    // Stretch the cube upward to its height, then slide it to its spot.
    // This does the same job as the old per-cube uModel matrix
    // (translation × scaling), without needing a matrix for every cube.
    vec3 world = vec3(
      aPosition.x + aOffset.x,
      aPosition.y * aHeight,
      aPosition.z + aOffset.y
    );

    // Stretching only along y never changes which way a face points,
    // so the normal can be passed through unchanged.
    vNormal = aNormal;
    vColor = aColor;

    // world -> camera -> screen.
    gl_Position = uProjection * uView * vec4(world, 1.0);
  }
`;

const terrainFragmentSource = /* glsl */ `
  precision mediump float;    // how accurate decimal numbers are (medium is plenty)

  varying vec3 vNormal;       // received from the vertex shader
  varying vec3 vColor;

  void main() {
    // Simple lighting so we can tell the faces of a cube apart.
    // The light shines from above and slightly to the side.
    vec3 lightDirection = normalize(vec3(0.5, 1.0, 0.3));

    // dot() measures how closely two directions line up:
    //   1 = the face points straight at the light (brightest)
    //   0 = the face is sideways to the light
    //   negative = the face points away, so max() clamps it to 0 (dark)
    float brightness = max(dot(normalize(vNormal), lightDirection), 0.0);

    // Keep 30% "ambient" light so faces in shadow aren't pure black.
    float light = 0.3 + 0.7 * brightness;

    // gl_FragColor is the built-in output: the final color of this pixel.
    gl_FragColor = vec4(vColor * light, 1.0);   // 1.0 = fully opaque
  }
`;

// ---- 1b. Sky block shaders (textured) ---------------------------------
const skyBlockVertexSource = /* glsl */ `
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  attribute vec2 aTexCoord;   // which point of the picture this corner shows

  uniform mat4 uModel;        // moves/scales the sky block into the world
  uniform mat4 uView;
  uniform mat4 uProjection;
  uniform float uRepeat;      // how many times the picture repeats per face

  varying vec3 vNormal;
  varying vec2 vTexCoord;

  void main() {
    vNormal = normalize(mat3(uModel) * aNormal);

    // Texture coordinates run 0..1 across a face. Multiplying by
    // uRepeat makes them run 0..uRepeat, and because the texture's wrap
    // mode is REPEAT, the picture tiles uRepeat × uRepeat times.
    vTexCoord = aTexCoord * uRepeat;

    gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
  }
`;

const skyBlockFragmentSource = /* glsl */ `
  precision mediump float;

  uniform sampler2D uTexture; // the flying machine picture

  varying vec3 vNormal;
  varying vec2 vTexCoord;

  void main() {
    vec3 lightDirection = normalize(vec3(0.5, 1.0, 0.3));
    float brightness = max(dot(normalize(vNormal), lightDirection), 0.0);
    float light = 0.45 + 0.55 * brightness;

    // texture2D looks up the color of the picture at this spot.
    vec3 texColor = texture2D(uTexture, vTexCoord).rgb;
    gl_FragColor = vec4(texColor * light, 1.0);
  }
`;

// Compile one shader and report any GLSL errors.
function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

// A "program" for the GPU
// is a vertex shader + a fragment shader linked together.
function createProgram(vertexSource, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  return program;
}

const terrainProgram = createProgram(terrainVertexSource, terrainFragmentSource);
const skyBlockProgram = createProgram(skyBlockVertexSource, skyBlockFragmentSource);


// ---------------------------------------------------------------------
// 2. CUBE GEOMETRY → BUFFER
//
//    WHAT IS A BUFFER?
//    The GPU has its own memory, separate from the memory JavaScript
//    uses. The GPU can't reach into our JavaScript arrays while it
//    draws, so we copy the data over ahead of time. A BUFFER is a block
//    of GPU memory that holds that copy.
//
//    CUBE details
//    One cube, 1 unit wide, with its bottom at y = 0 (so it sits on the
//    ground). The ground cubes and the sky block share this same data.
//
//    Each face = 2 triangles = 6 vertices. Each vertex has 8 numbers:
//         x,    y,    z,      nx, ny, nz,    u, v
//       (position,            normal,        texture coordinate)
//
//    (u, v) says which point of the picture lands on this corner:
//    (0, 0) is the picture's bottom-left, (1, 1) its top-right.
//    The terrain program simply ignores u and v.
// ---------------------------------------------------------------------
const cubeVertices = new Float32Array([
  // Front face (normal points toward +z)
  -0.5, 0,  0.5,   0,  0,  1,   0, 0,
   0.5, 0,  0.5,   0,  0,  1,   1, 0,
   0.5, 1,  0.5,   0,  0,  1,   1, 1,
  -0.5, 0,  0.5,   0,  0,  1,   0, 0,
   0.5, 1,  0.5,   0,  0,  1,   1, 1,
  -0.5, 1,  0.5,   0,  0,  1,   0, 1,

  // Back face (-z)
  -0.5, 0, -0.5,   0,  0, -1,   1, 0,
   0.5, 1, -0.5,   0,  0, -1,   0, 1,
   0.5, 0, -0.5,   0,  0, -1,   0, 0,
  -0.5, 0, -0.5,   0,  0, -1,   1, 0,
  -0.5, 1, -0.5,   0,  0, -1,   1, 1,
   0.5, 1, -0.5,   0,  0, -1,   0, 1,

  // Top face (+y)
  -0.5, 1, -0.5,   0,  1,  0,   0, 1,
  -0.5, 1,  0.5,   0,  1,  0,   0, 0,
   0.5, 1,  0.5,   0,  1,  0,   1, 0,
  -0.5, 1, -0.5,   0,  1,  0,   0, 1,
   0.5, 1,  0.5,   0,  1,  0,   1, 0,
   0.5, 1, -0.5,   0,  1,  0,   1, 1,

  // Bottom face (-y)
  -0.5, 0, -0.5,   0, -1,  0,   0, 0,
   0.5, 0,  0.5,   0, -1,  0,   1, 1,
  -0.5, 0,  0.5,   0, -1,  0,   0, 1,
  -0.5, 0, -0.5,   0, -1,  0,   0, 0,
   0.5, 0, -0.5,   0, -1,  0,   1, 0,
   0.5, 0,  0.5,   0, -1,  0,   1, 1,

  // Right face (+x)
   0.5, 0, -0.5,   1,  0,  0,   1, 0,
   0.5, 1, -0.5,   1,  0,  0,   1, 1,
   0.5, 1,  0.5,   1,  0,  0,   0, 1,
   0.5, 0, -0.5,   1,  0,  0,   1, 0,
   0.5, 1,  0.5,   1,  0,  0,   0, 1,
   0.5, 0,  0.5,   1,  0,  0,   0, 0,

  // Left face (-x)
  -0.5, 0, -0.5,  -1,  0,  0,   0, 0,
  -0.5, 1,  0.5,  -1,  0,  0,   1, 1,
  -0.5, 1, -0.5,  -1,  0,  0,   0, 1,
  -0.5, 0, -0.5,  -1,  0,  0,   0, 0,
  -0.5, 0,  0.5,  -1,  0,  0,   1, 0,
  -0.5, 1,  0.5,  -1,  0,  0,   1, 1,
]);
const VERTEX_COUNT = 36;

const BYTES_PER_FLOAT = 4;
const CUBE_STRIDE = 8 * BYTES_PER_FLOAT;   // 8 numbers per vertex

// Copy the vertex data into GPU memory.
//   createBuffer - reserve a new, empty buffer on the GPU
//   bindBuffer   - make it the "current" buffer; the next buffer
//                  commands act on whichever buffer is bound
//                  (ARRAY_BUFFER means "this holds vertex data")
//   bufferData   - copy our numbers into it. STATIC_DRAW is a hint
//                  that we'll fill it once and draw from it many times.
const cubeBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffer);
gl.bufferData(gl.ARRAY_BUFFER, cubeVertices, gl.STATIC_DRAW);

// Look up where each attribute and uniform lives in each program.
// These variables hold a LOCATION (a slot number in the program), not
// the value itself. Each program has its own slots, so we look them up
// separately for each one.
const terrainLoc = {
  aPosition:   gl.getAttribLocation(terrainProgram, 'aPosition'),
  aNormal:     gl.getAttribLocation(terrainProgram, 'aNormal'),
  aOffset:     gl.getAttribLocation(terrainProgram, 'aOffset'),
  aHeight:     gl.getAttribLocation(terrainProgram, 'aHeight'),
  aColor:      gl.getAttribLocation(terrainProgram, 'aColor'),
  uView:       gl.getUniformLocation(terrainProgram, 'uView'),
  uProjection: gl.getUniformLocation(terrainProgram, 'uProjection'),
};

const skyBlockLoc = {
  aPosition:   gl.getAttribLocation(skyBlockProgram, 'aPosition'),
  aNormal:     gl.getAttribLocation(skyBlockProgram, 'aNormal'),
  aTexCoord:   gl.getAttribLocation(skyBlockProgram, 'aTexCoord'),
  uModel:      gl.getUniformLocation(skyBlockProgram, 'uModel'),
  uView:       gl.getUniformLocation(skyBlockProgram, 'uView'),
  uProjection: gl.getUniformLocation(skyBlockProgram, 'uProjection'),
  uRepeat:     gl.getUniformLocation(skyBlockProgram, 'uRepeat'),
  uTexture:    gl.getUniformLocation(skyBlockProgram, 'uTexture'),
};

// Hook one attribute up to the currently bound buffer.
//   enableVertexAttribArray - say "fill this attribute from a buffer"
//   vertexAttribPointer     - say HOW: `size` numbers each, as floats,
//                             stepping `stride` bytes from one vertex
//                             (or instance) to the next, starting at
//                             `offset` bytes in
//   divisor 0 = advance once per VERTEX (a normal attribute)
//   divisor 1 = advance once per INSTANCE (once per cube copy)
function setAttribute(location, size, stride, offset, divisor) {
  if (location === -1) return;   // the shader doesn't use it
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  instancing.vertexAttribDivisorANGLE(location, divisor);
}

// Turn an attribute back off. Attribute settings are shared between
// programs, so after drawing we switch off anything the other program
// doesn't use.
function clearAttribute(location) {
  if (location === -1) return;
  instancing.vertexAttribDivisorANGLE(location, 0);
  gl.disableVertexAttribArray(location);
}


// ---------------------------------------------------------------------
// 3. THE SCENE
//    The ground cubes are laid out in a grid on the ground plane
//    (y = 0), centered on the origin, one cube per pixel.
// ---------------------------------------------------------------------
const SPACING = 1.0;    // distance between cube centers

// All three images sit next to this file. The page must be opened
// through a server (GitHub Pages, or python -m http.server locally),
// not as a file:// address, or the browser blocks reading their pixels.
const COLOR_IMAGE = './mona_lisa.jpg';
const GREY_IMAGE = './mona_lisa_grey.jpg';
const SKY_BLOCK_TEXTURE = './flying_machine.jpg';

const MIN_HEIGHT = 0.5;   // so black pixels still show up as a thin tile
const MAX_HEIGHT = 50;    // height of a pure white (255) pixel

// Turn a 0..255 grey value into a cube height.
function greyToHeight(value) {
  return MIN_HEIGHT + (value / 255) * (MAX_HEIGHT - MIN_HEIGHT);
}

// Load an image and wait for it to finish loading.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

// Draw an image onto a hidden canvas and return its pixel data:
// a flat list of numbers, 4 per pixel (red, green, blue, alpha),
// going left to right across each row, rows top to bottom.
function getPixels(img) {
  const offscreen = document.createElement('canvas');
  offscreen.width = img.width;
  offscreen.height = img.height;
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height).data;
}

// ---- 3a. Ground cubes -------------------------------------------------
// Instead of a list of cube objects, each cube is 6 numbers in one long
// Float32Array:
//      x, z,   height,   r, g, b
// That array is copied into instanceBuffer, and the terrain shader
// reads one group of 6 per cube copy.
const INSTANCE_FLOATS = 6;
const INSTANCE_STRIDE = INSTANCE_FLOATS * BYTES_PER_FLOAT;
const instanceBuffer = gl.createBuffer();
let cubeCount = 0;      // stays 0 until the images have loaded

async function buildScene() {
  // Load both images at the same time and wait until both are ready.
  const [colorImage, greyImage] = await Promise.all([
    loadImage(COLOR_IMAGE),
    loadImage(GREY_IMAGE),
  ]);

  if (colorImage.width !== greyImage.width || colorImage.height !== greyImage.height) {
    console.warn('Color and greyscale images are different sizes');
  }

  const colorData = getPixels(colorImage);
  const greyData = getPixels(greyImage);

  const cols = greyImage.width;    // 400 for the Mona Lisa
  const rows = greyImage.height;   // 482 for the Mona Lisa

  const instanceData = new Float32Array(rows * cols * INSTANCE_FLOATS);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cube = row * cols + col;        // which cube this is
      const pixelIndex = cube * 4;          // where its pixel starts
      const i = cube * INSTANCE_FLOATS;     // where its data starts

      const grey = greyData[pixelIndex];    // red channel = grey value

      instanceData[i]     = (col - (cols - 1) / 2) * SPACING;   // x
      instanceData[i + 1] = (row - (rows - 1) / 2) * SPACING;   // z
      instanceData[i + 2] = greyToHeight(grey);                 // height
      instanceData[i + 3] = colorData[pixelIndex] / 255;        // r
      instanceData[i + 4] = colorData[pixelIndex + 1] / 255;    // g
      instanceData[i + 5] = colorData[pixelIndex + 2] / 255;    // b
    }
  }

  // Copy all the cubes into GPU memory, once.
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.STATIC_DRAW);
  cubeCount = rows * cols;

  draw();
}

// ---- 3b. Sky block texture --------------------------------------------
// A TEXTURE is a picture stored in GPU memory that shaders can read.
const TEXTURE_SIZE = 512;    // WebGL 1 can only REPEAT a texture whose
                             // width and height are powers of two
                             // (256, 512, 1024...), so the picture is
                             // redrawn at 512 × 512 first.
const TEXTURE_REPEAT = 2.0;  // the picture tiles 2 × 2 on every face

const skyBlockTexture = gl.createTexture();

// Put a canvas's pixels into skyBlockTexture.
function uploadTexture(sourceCanvas) {
  gl.bindTexture(gl.TEXTURE_2D, skyBlockTexture);

  // Images store their top row first, but WebGL expects the bottom row
  // first. Flipping on upload keeps the picture right side up.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, sourceCanvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  // REPEAT: coordinates past 1.0 wrap back around to 0.0, which is
  // what makes the picture tile.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  // Mipmaps are smaller copies of the picture that the GPU uses when
  // the block is far away, so the texture doesn't shimmer.
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

async function buildSkyBlockTexture() {
  // Until the picture loads, use a single light blue pixel (the sky
  // block's old color) so the block is never invisible.
  const placeholder = document.createElement('canvas');
  placeholder.width = placeholder.height = 1;
  const ctx = placeholder.getContext('2d');
  ctx.fillStyle = 'rgb(128, 179, 255)';
  ctx.fillRect(0, 0, 1, 1);
  uploadTexture(placeholder);

  try {
    const img = await loadImage(SKY_BLOCK_TEXTURE);
    const c = document.createElement('canvas');
    c.width = c.height = TEXTURE_SIZE;
    c.getContext('2d').drawImage(img, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    uploadTexture(c);
  } catch (err) {
    console.warn(`${SKY_BLOCK_TEXTURE} not found, the sky block stays plain`);
  }
  draw();
}

buildScene().catch((err) => console.error(err));
buildSkyBlockTexture();


// ---------------------------------------------------------------------
// 4. MATRIX HELPERS
//    A 4×4 matrix can move, scale, or rotate points. WebGL stores
//    matrices as 16 numbers in "column-major" order: the first 4 numbers
//    are the first COLUMN, not the first row. That's why the translation
//    (x, y, z) appears in the last 4 numbers below.
//
//    (Real projects usually use a library such as glMatrix for this.)
// ---------------------------------------------------------------------

// Move a point by (x, y, z).
function translation(x, y, z) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

// Stretch a point by (sx, sy, sz).
function scaling(sx, sy, sz) {
  return [
    sx, 0,  0,  0,
    0,  sy, 0,  0,
    0,  0,  sz, 0,
    0,  0,  0,  1,
  ];
}

// Multiply two matrices: the result does b first, then a.
function multiply(a, b) {
  const result = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) {
        result[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
      }
    }
  }
  return result;
}

// Perspective projection: makes far-away objects look smaller.
//   fieldOfView - how wide the camera sees, in radians
//   aspect      - canvas width / height, so things aren't stretched
//   near, far   - nothing closer than near or farther than far is drawn
function perspective(fieldOfView, aspect, near, far) {
  const f = 1 / Math.tan(fieldOfView / 2);
  return [
    f / aspect, 0, 0,                               0,
    0,          f, 0,                               0,
    0,          0, (far + near) / (near - far),    -1,
    0,          0, (2 * far * near) / (near - far), 0,
  ];
}

// Camera matrix: place a camera at `eye`, looking at `target`.
// `up` says which way is "up" for the camera (normally +y).
function lookAt(eye, target, up) {
  const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normalize = (a) => {
    const length = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / length, a[1] / length, a[2] / length];
  };

  // Build the camera's own three axes:
  const zAxis = normalize(subtract(eye, target)); // points backward, away from what we look at
  const xAxis = normalize(cross(up, zAxis));      // points to the camera's right
  const yAxis = cross(zAxis, xAxis);              // points to the camera's up

  return [
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dot(xAxis, eye), -dot(yAxis, eye), -dot(zAxis, eye), 1,
  ];
}

// Bezier Curve Functions
function bezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return [
    mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0],
    mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1],
    mt * mt * mt * p0[2] + 3 * mt * mt * t * p1[2] + 3 * mt * t * t * p2[2] + t * t * t * p3[2]
  ];
}

// Control Points
const p0 = [-200,  50,   0];
const p1 = [-100, 200, 200];
const p2 = [ 100, 200, 200];
const p3 = [ 200,  50,   0];

const skyBlock = {
  position: [...p0],
  scale: [20, 20, 20],
};

// Bezier Curve Animation
// The block flies p0 -> p3, then back p3 -> p0, forever.
const tripDuration = 4000;   // milliseconds for one trip across

// Where on the curve (t = 0..1) the block is at a given time.
// A plain back-and-forth would reverse instantly at each end, which
// looks like a bounce. Using cosine instead makes t slow down as it
// reaches 0 or 1 and speed up in the middle, so the block eases into
// each turnaround:
//   time 0             -> t = 0  (at p0)
//   time tripDuration  -> t = 1  (at p3)
//   time 2×trip        -> t = 0  (back at p0)
function curveT(milliseconds) {
  const phase = (milliseconds / tripDuration) * Math.PI;
  return (1 - Math.cos(phase)) / 2;
}

// The animation loop: the browser calls animate() before every screen
// refresh (about 60 times a second), passing the time in milliseconds.
// Each call moves the block, draws one frame, and asks for the next.
function animate(currentTime) {
  skyBlock.position = bezierPoint(p0, p1, p2, p3, curveT(currentTime));
  draw();
  requestAnimationFrame(animate);
}


// ---------------------------------------------------------------------
// 5. DRAW
//    Everything above was SETUP: it ran once and got the shaders, the
//    buffers, and the cubes ready. draw() is where we actually produce
//    a picture. It follows the same steps every time:
//
//      a. size the drawing area to match the window
//      b. wipe the previous picture
//      c. set the camera
//      d. draw ALL the ground cubes in one instanced call
//      e. draw the textured sky block
//
//    Note that we never send any cube data again here - it is already
//    sitting in GPU buffers. That's what makes draw() fast enough to run
//    every frame, which it does: animate() calls it continuously.
// ---------------------------------------------------------------------

// Current camera state (starting top-down)
let cameraEye = [0, 750, 0];
let cameraUp = [0, 0, -1];
const cameraTarget = [0, 0, 0];

function drawTerrain(view, projection) {
  if (cubeCount === 0) return;   // images haven't loaded yet

  gl.useProgram(terrainProgram);
  gl.uniformMatrix4fv(terrainLoc.uView, false, view);
  gl.uniformMatrix4fv(terrainLoc.uProjection, false, projection);

  // Per-vertex data comes from the shared cube buffer...
  gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffer);
  setAttribute(terrainLoc.aPosition, 3, CUBE_STRIDE, 0, 0);
  setAttribute(terrainLoc.aNormal,   3, CUBE_STRIDE, 3 * BYTES_PER_FLOAT, 0);

  // ...and per-cube data from the instance buffer (divisor 1).
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  setAttribute(terrainLoc.aOffset, 2, INSTANCE_STRIDE, 0, 1);
  setAttribute(terrainLoc.aHeight, 1, INSTANCE_STRIDE, 2 * BYTES_PER_FLOAT, 1);
  setAttribute(terrainLoc.aColor,  3, INSTANCE_STRIDE, 3 * BYTES_PER_FLOAT, 1);

  // "Draw the 36-vertex cube cubeCount times." One call for the whole
  // painting, instead of one call per cube.
  instancing.drawArraysInstancedANGLE(gl.TRIANGLES, 0, VERTEX_COUNT, cubeCount);

  // Leave the attribute slots clean for the sky block program.
  clearAttribute(terrainLoc.aOffset);
  clearAttribute(terrainLoc.aHeight);
  clearAttribute(terrainLoc.aColor);
}

function drawSkyBlock(view, projection) {
  const skyModel = multiply(
    translation(skyBlock.position[0], skyBlock.position[1], skyBlock.position[2]),
    scaling(skyBlock.scale[0], skyBlock.scale[1], skyBlock.scale[2])
  );

  gl.useProgram(skyBlockProgram);
  gl.uniformMatrix4fv(skyBlockLoc.uModel, false, skyModel);
  gl.uniformMatrix4fv(skyBlockLoc.uView, false, view);
  gl.uniformMatrix4fv(skyBlockLoc.uProjection, false, projection);
  gl.uniform1f(skyBlockLoc.uRepeat, TEXTURE_REPEAT);

  // Textures are read through numbered "texture units". Put ours in
  // unit 0 and tell the shader's sampler to read unit 0.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, skyBlockTexture);
  gl.uniform1i(skyBlockLoc.uTexture, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffer);
  setAttribute(skyBlockLoc.aPosition, 3, CUBE_STRIDE, 0, 0);
  setAttribute(skyBlockLoc.aNormal,   3, CUBE_STRIDE, 3 * BYTES_PER_FLOAT, 0);
  setAttribute(skyBlockLoc.aTexCoord, 2, CUBE_STRIDE, 6 * BYTES_PER_FLOAT, 0);

  gl.drawArrays(gl.TRIANGLES, 0, VERTEX_COUNT);

  clearAttribute(skyBlockLoc.aTexCoord);
}

function draw() {
  // --- a. Size the drawing area -------------------------------------
  // A canvas has two sizes: how big it looks on the page (set by CSS),
  // and how many pixels it actually has. If they don't match, the
  // picture gets stretched and blurry, so we make them match. Only do
  // it when they differ: resizing a canvas is slow, and draw() now runs
  // every frame while the sky block flies.
  if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }

  // The viewport tells WebGL which rectangle of the canvas to draw
  // into (here, the whole canvas).
  gl.viewport(0, 0, canvas.width, canvas.height);

  // --- b. Wipe the previous picture ---------------------------------
  // Depth testing makes near cubes hide far cubes, no matter which
  // order we draw them in.
  gl.clearColor(0, 0, 0, 1);
  gl.enable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // --- c. Set the camera --------------------------------------------
  // The camera is the same for everything drawn this frame.
  const aspect = canvas.width / canvas.height;
  const projection = perspective(Math.PI / 4, aspect, 0.1, 2000);
  const view = lookAt(cameraEye, cameraTarget, cameraUp);

  // --- d, e. Draw ---------------------------------------------------
  drawTerrain(view, projection);
  drawSkyBlock(view, projection);
}

const startEye = [0, 750, 0];
const startUp = [0, 0, -1];

const endEye = [0, 200, 600];
const endUp = [0, 1, 0];

// How many button clicks it takes to reach the end
const TOTAL_STEPS = 10;
let currentStep = 0;

document.getElementById('moveCameraBtn').addEventListener('click', () => {
  // Advance the step counter
  if (currentStep < TOTAL_STEPS) {
    currentStep++;
  } else {
    // Reset to the starting position after reaching the end
    currentStep = 0;
  }
  const t = currentStep / TOTAL_STEPS;

  cameraEye = [
    startEye[0] * (1 - t) + endEye[0] * t,
    startEye[1] * (1 - t) + endEye[1] * t,
    startEye[2] * (1 - t) + endEye[2] * t,
  ];
  cameraUp = [
    startUp[0] * (1 - t) + endUp[0] * t,
    startUp[1] * (1 - t) + endUp[1] * t,
    startUp[2] * (1 - t) + endUp[2] * t,
  ];
  // No draw() needed: the animation loop picks up the new camera on
  // its next frame.
});

// Start the animation loop. It runs from page load onward, so the sky
// block is always flying, and window resizes and camera moves show up
// on the next frame automatically.
requestAnimationFrame(animate);