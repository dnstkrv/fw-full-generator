let routers;
let routerCfg;

const routerSelect = document.getElementById("routerSelect");
const layoutSelect = document.getElementById("layoutSelect");
const partsDiv = document.getElementById("parts");
const logEl = document.getElementById("log");
const buildBtn = document.getElementById("buildBtn");
const progressEl = document.getElementById("buildProgress");
const macInputEl = document.getElementById("customMac");
const warningEl = document.getElementById("macWarning");

const basePath = "/fw-full-generator/";

function log(msg) {
    logEl.textContent += msg + "\n";
}

function clearLog() {
    logEl.textContent = "";
}

function formatMac(mac) {
    return Array.from(mac)
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(':');
}

function logPart(name, action, offset, extra="") {
    const colWidths = [12, 25, 14];
    const col1 = name.padEnd(colWidths[0]);
    const col2 = action.padEnd(colWidths[1]);
    const col3 = `@ 0x${offset.toString(16).toUpperCase()}`.padEnd(colWidths[2]);
    log(`${col1}${col2}${col3}${extra}`);
}

function generateMac() {
    const mac = new Uint8Array(6);
    crypto.getRandomValues(mac);
    mac[0] = (mac[0] & 0xfe) | 0x02;
    return mac;
}

async function loadRouters() {
    routers = await (await fetch(`${basePath}routers.json`)).json();

    for (const id in routers) {
        routerSelect.add(new Option(routers[id], id));
    }

    routerSelect.addEventListener("change", loadLayouts);
    loadLayouts();

    macInputEl.addEventListener("input", () => {
        const macInput = macInputEl.value.trim();
        if (macInput && !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(macInput)) {
            warningEl.textContent = "Некорректный формат MAC (ожидается AA:BB:CC:DD:EE:FF)";
            warningEl.style.color = "red";
        } else {
            warningEl.textContent = "";
        }
    });
}

async function loadLayouts() {
    const router = routerSelect.value;
    routerCfg = await (await fetch(`${basePath}routers/${router}/layouts.json`)).json();

    layoutSelect.innerHTML = "";
    for (const id in routerCfg.layouts) {
        layoutSelect.add(new Option(routerCfg.layouts[id].name, id));
    }

    layoutSelect.addEventListener("change", renderParts);
    renderParts();
}

function renderParts() {
    partsDiv.innerHTML = "";
    const layout = routerCfg.layouts[layoutSelect.value];

    for (const partName in layout.map) {
        const p = routerCfg.parts[partName];
        const sizeInfo = p.max_size && p.max_size > 0
            ? ` (≤ ${Math.round(p.max_size / 1024)} KB)`
            : "";

        const div = document.createElement("div");
        div.className = "part";

        div.innerHTML = `
            <label>${partName}${sizeInfo}</label>
            <div class="file-input-wrapper">
                <input type="file" data-part="${partName}">
                <span class="file-btn">Выбрать файл</span>
                <span class="file-name">Файл не выбран</span>
            </div>
        `;
        partsDiv.appendChild(div);
    }

    document.querySelectorAll('.file-input-wrapper input[type="file"]').forEach(input => {
        input.addEventListener('change', () => {
            const fileNameSpan = input.parentElement.querySelector('.file-name');
            if (input.files.length) {
                const sizeKB = Math.round(input.files[0].size / 1024);
                fileNameSpan.textContent = `${input.files[0].name} (${sizeKB} KB)`;
            } else {
                fileNameSpan.textContent = "Файл не выбран";
            }
        });
    });
}

async function loadPart(router, name, cfg) {
    const input = document.querySelector(`input[data-part="${name}"]`);
    let data;
    let isDefault = false;

    if (input && input.files.length) {
        data = new Uint8Array(await input.files[0].arrayBuffer());
    } else {
        let defaultFile = cfg.default;
        if (cfg.default_128 && cfg.default_256 && layoutSelect.value) {
            defaultFile = layoutSelect.value.includes("128") ? cfg.default_128 : cfg.default_256;
        }

        const url = `${basePath}routers/${router}/defaults/${defaultFile}?t=${Date.now()}`;
        const res = await fetch(url);
        if (!res.ok) throw `Нет дефолтного файла для ${name}: ${defaultFile}`;

        const contentLength = res.headers.get("Content-Length");
        const total = contentLength ? parseInt(contentLength) : 0;

        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;

            if (total) {
                progressEl.value = (received / total) * 100;
            }
        }

        const size = chunks.reduce((acc, cur) => acc + cur.length, 0);
        data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }

        isDefault = true;
        if (cfg.compressed) data = pako.ungzip(data);
    }

    if (cfg.max_size && cfg.max_size > 0 && data.length > cfg.max_size) {
        throw `${name}: размер ${data.length} превышает ${cfg.max_size}`;
    }

    if (cfg.inject_mac && isDefault) {
        const macInput = macInputEl.value.trim();
        let mac;

        if (macInput) {
            if (/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(macInput)) {
                mac = new Uint8Array(macInput.split(":").map(b => parseInt(b, 16)));
                warningEl.textContent = "";
            } else {
                warningEl.textContent = "Некорректный MAC";
                throw "Некорректный MAC, сборка невозможна";
            }
        } else {
            mac = generateMac();
            warningEl.textContent = "";
        }

        const offset = typeof cfg.mac_offset === "string" ? parseInt(cfg.mac_offset, 16) : cfg.mac_offset;
        if (offset + 6 > data.length) throw `${name}: MAC не помещается в файл. Длина ${data.length}, mac_offset ${offset}`;
        data.set(mac, offset);
    }

    return data;
}

async function build() {
    try {
        clearLog();
        progressEl.value = 0;
        progressEl.style.display = "block";

        const router = routerSelect.value;
        const layoutId = layoutSelect.value;
        const layout = routerCfg.layouts[layoutId];

        const flashSize = layout.flash_size;
        const image = new Uint8Array(flashSize);
        image.fill(0xFF);

        const partsMap = layout.map;
        const totalParts = Object.keys(partsMap).length;
        let loadedParts = 0;

        for (const name in partsMap) {
            const partCfg = { ...routerCfg.parts[name], ...partsMap[name] };
            const offset = partsMap[name].offset;

            const data = await loadPart(router, name, partCfg);
            image.set(data, offset);

            logPart(name, "Записан", offset);

            loadedParts++;
            progressEl.value = (loadedParts / totalParts) * 100;
        }

        const blob = new Blob([image], { type: "application/octet-stream" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "full.bin";
        a.click();

        log("Сборка завершена");
    } catch (e) {
        log("ОШИБКА: " + e);
    } finally {
        progressEl.style.display = "none";
    }
}

buildBtn.addEventListener("click", build);
loadRouters();
