(() => {
  const el = (id) => document.getElementById(id);
  const canvas = el("world-view");
  const context = canvas.getContext("2d", { alpha: false });
  const image = context.createImageData(canvas.width, canvas.height);
  const toggle = el("world-view-toggle");
  const status = el("world-view-status");
  const nickname = el("desktop-nickname");
  let enabled = false;
  let phase = "disconnected";
  let generation = 0;
  let timer;
  let currentDimension;

  const colors = [
    [/grass|leaves|moss|sapling/u, [97, 143, 76]],
    [/water|ice/u, [67, 134, 166]],
    [/sand|end_stone/u, [205, 184, 125]],
    [/dirt|mud|log|wood|planks/u, [136, 101, 75]],
    [/netherrack|lava|crimson/u, [164, 75, 63]],
    [/snow|quartz/u, [214, 221, 218]],
    [/stone|ore|deepslate|bedrock/u, [128, 133, 140]],
  ];
  const sky = [132, 169, 177];
  const fog = [88, 108, 116];

  function colorFor(name) {
    const material = colors.find(([pattern]) => pattern.test(name));
    if (material) return material[1];
    let hash = 0;
    for (const char of name) hash = (31 * hash + char.charCodeAt(0)) | 0;
    return [88 + (hash & 63), 90 + ((hash >>> 8) & 63), 96 + ((hash >>> 16) & 63)];
  }

  function draw({ eye, yaw, pitch, origin, width, height, palette, voxels }) {
    const materials = palette.map(colorFor);
    const sx = Math.sin(yaw);
    const sz = Math.cos(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const ex = eye.x - origin.x;
    const ey = eye.y - origin.y;
    const ez = eye.z - origin.z;
    const bx = Math.floor(ex);
    const by = Math.floor(ey);
    const bz = Math.floor(ez);
    for (let row = 0; row < canvas.height; row++) {
      const v = (canvas.height - 2 * row - 1) * 0.56 / canvas.height;
      for (let col = 0; col < canvas.width; col++) {
        const u = (2 * col + 1 - canvas.width) * 0.56 / canvas.height;
        const dx = -sx * cp + sz * u + sx * sp * v;
        const dy = sp + cp * v;
        const dz = -sz * cp - sx * u + sz * sp * v;
        const stepX = dx < 0 ? -1 : 1;
        const stepY = dy < 0 ? -1 : 1;
        const stepZ = dz < 0 ? -1 : 1;
        const ax = Math.abs(1 / dx);
        const ay = Math.abs(1 / dy);
        const az = Math.abs(1 / dz);
        let nextX = dx === 0 ? Infinity : (stepX < 0 ? ex - bx : bx + 1 - ex) * ax;
        let nextY = dy === 0 ? Infinity : (stepY < 0 ? ey - by : by + 1 - ey) * ay;
        let nextZ = dz === 0 ? Infinity : (stepZ < 0 ? ez - bz : bz + 1 - ez) * az;
        let [x, y, z] = [bx, by, bz];
        let shade = 1;
        let distance = 0;
        let rgb = sky;
        while (x >= 0 && x < width && y >= 0 && y < height && z >= 0 && z < width) {
          const voxel = voxels[(y * width + z) * width + x];
          if (voxel !== 1) {
            rgb = voxel === 0 ? fog : materials[voxel];
            break;
          }
          if (nextX <= nextY && nextX <= nextZ) {
            x += stepX;
            distance = nextX;
            nextX += ax;
            shade = 0.77;
          } else if (nextY <= nextZ) {
            y += stepY;
            distance = nextY;
            nextY += ay;
            shade = stepY < 0 ? 1 : 0.59;
          } else {
            z += stepZ;
            distance = nextZ;
            nextZ += az;
            shade = 0.89;
          }
        }
        const index = (row * canvas.width + col) * 4;
        const haze = rgb === sky || rgb === fog ? 1 : Math.max(0.63, 1 - distance * 0.025) * shade;
        image.data[index] = rgb[0] * haze;
        image.data[index + 1] = rgb[1] * haze;
        image.data[index + 2] = rgb[2] * haze;
        image.data[index + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }

  function label(text) {
    if (status.textContent !== text) status.textContent = text;
  }

  function viewLabel(dimension) {
    return `${nickname.value.trim() || "MC-Pal"} · ${dimension || "未知维度"} · 已同步的方块`;
  }

  async function poll(token) {
    let frame;
    try {
      frame = await window.minecraft.readView();
    } catch {
      if (token !== generation) return;
      currentDimension = undefined;
      canvas.hidden = true;
      context.clearRect(0, 0, canvas.width, canvas.height);
      label("无法读取视角");
    }
    if (token !== generation) return;
    if (frame) {
      draw(frame);
      currentDimension = frame.dimension ?? "";
      canvas.hidden = false;
      label(viewLabel(currentDimension));
    } else if (frame === null) {
      currentDimension = undefined;
      canvas.hidden = true;
      context.clearRect(0, 0, canvas.width, canvas.height);
      label("等待当前位置的区块");
    }
    timer = setTimeout(() => poll(token), 150);
  }

  function refresh() {
    generation++;
    clearTimeout(timer);
    currentDimension = undefined;
    canvas.hidden = true;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!enabled) label("第一人称已关闭");
    else if (phase === "positioning") label("等待当前位置和维度");
    else if (phase !== "ready") label("等待 Minecraft 连接就绪");
    else if (!el("minecraft-workspace").closest("[hidden]")) {
      label("等待当前位置的区块");
      void poll(generation);
    }
  }

  function onState(state) {
    if (phase === state.phase) return;
    phase = state.phase;
    refresh();
  }

  window.minecraft.onState(onState);
  window.minecraft.snapshot().then(onState).catch(() => label("无法读取视角"));
  toggle.addEventListener("click", () => {
    enabled = !enabled;
    toggle.setAttribute("aria-pressed", String(enabled));
    refresh();
  });
  const visibility = new MutationObserver(refresh);
  for (const id of ["desktop-workspaces", "minecraft-workspace"]) {
    visibility.observe(el(id), { attributes: true, attributeFilter: ["hidden"] });
  }

  nickname.value = localStorage.getItem("mcpal-desktop-nickname") ?? "MC-Pal";
  nickname.addEventListener("input", () => {
    localStorage.setItem("mcpal-desktop-nickname", nickname.value);
    if (currentDimension !== undefined && !canvas.hidden) label(viewLabel(currentDimension));
  });

  const preview = el("skin-preview").getContext("2d");
  const skin = el("desktop-skin");
  const skinStatus = el("skin-preview-status");
  let selection = 0;

  function defaultSkin() {
    preview.clearRect(0, 0, 16, 32);
    for (const [color, x, y, w, h] of [
      ["#263b45", 4, 20, 8, 12], ["#39766f", 0, 8, 16, 12], ["#c88f69", 4, 0, 8, 8],
      ["#263b45", 4, 0, 8, 2], ["#263b45", 5, 4, 2, 1], ["#263b45", 9, 4, 2, 1],
    ]) {
      preview.fillStyle = color;
      preview.fillRect(x, y, w, h);
    }
  }

  defaultSkin();
  skin.addEventListener("change", async () => {
    const token = ++selection;
    const file = skin.files[0];
    defaultSkin();
    skinStatus.textContent = "默认桌面预览";
    if (!file) return;
    let bitmap;
    try {
      if (file.type !== "image/png" || file.size > 128 * 1024) throw new Error("Invalid PNG");
      const header = new DataView(await file.slice(0, 24).arrayBuffer());
      if (token !== selection) return;
      if (header.getBigUint64(0) !== 0x89504e470d0a1a0an || header.getUint32(8) !== 13 ||
        header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== 64 ||
        ![32, 64].includes(header.getUint32(20))) throw new Error("Invalid skin dimensions");
      bitmap = await createImageBitmap(file);
      if (token !== selection) return;
      preview.clearRect(0, 0, 16, 32);
      const parts = [
        [8, 8, 8, 8, 4, 0], [20, 20, 8, 12, 4, 8], [44, 20, 4, 12, 0, 8],
        [4, 20, 4, 12, 4, 20], [40, 8, 8, 8, 4, 0],
      ];
      if (bitmap.height === 64) {
        parts.push([36, 52, 4, 12, 12, 8], [20, 52, 4, 12, 8, 20],
          [20, 36, 8, 12, 4, 8], [44, 36, 4, 12, 0, 8], [52, 52, 4, 12, 12, 8],
          [4, 36, 4, 12, 4, 20], [4, 52, 4, 12, 8, 20]);
      } else {
        parts.push([44, 20, 4, 12, 12, 8], [4, 20, 4, 12, 8, 20]);
      }
      for (const [x, y, w, h, toX, toY] of parts) preview.drawImage(bitmap, x, y, w, h, toX, toY, w, h);
      skinStatus.textContent = "正在预览本地皮肤";
    } catch {
      if (token === selection) skinStatus.textContent = "请选择 64×64 或 64×32 的 PNG 皮肤";
    } finally {
      bitmap?.close();
    }
  });
})();
