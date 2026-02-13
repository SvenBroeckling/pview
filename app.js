const schemaInput = document.getElementById("schemaInput");
const loadExampleBtn = document.getElementById("loadExampleBtn");
const fitViewBtn = document.getElementById("fitViewBtn");
const darkModeToggle = document.getElementById("darkModeToggle");
const selectAllModelsBtn = document.getElementById("selectAllModelsBtn");
const clearModelsBtn = document.getElementById("clearModelsBtn");
const modelSearchInput = document.getElementById("modelSearchInput");
const modelSelectionHint = document.getElementById("modelSelectionHint");
const modelList = document.getElementById("modelList");
const statusText = document.getElementById("statusText");
const schemaInfo = document.getElementById("schemaInfo");
const emptyState = document.getElementById("emptyState");

const viewport = document.getElementById("graphViewport");
const stage = document.getElementById("graphStage");
const nodeLayer = document.getElementById("nodeLayer");
const edgeLayer = document.getElementById("edgeLayer");
const relationStubLayer = document.getElementById("relationStubLayer");

const WORLD_CENTER = { x: 2600, y: 2600 };
const NODE_WIDTH = 300;
const SPIRAL_SPACING = 240;

const DEMO_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  posts     Post[]
  comments  Comment[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Post {
  id        String    @id @default(cuid())
  title     String
  content   String?
  published Boolean   @default(false)
  author    User      @relation(fields: [authorId], references: [id])
  authorId  String
  comments  Comment[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

model Comment {
  id        String   @id @default(cuid())
  body      String
  post      Post     @relation(fields: [postId], references: [id])
  postId    String
  author    User     @relation(fields: [authorId], references: [id])
  authorId  String
  createdAt DateTime @default(now())
}`;

const state = {
  parsed: null,
  nodePositions: {},
  selectedModels: new Set(),
  fieldVisibilityByModel: {},
  modelSearchQuery: "",
  view: { x: 100, y: 60, scale: 0.85 },
  interaction: null,
  resizeObserver: null,
};

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? "var(--status-error)" : "var(--text-muted)";
}

function updateEmptyState() {
  if (!state.parsed) {
    emptyState.style.display = "grid";
    return;
  }
  emptyState.style.display = state.selectedModels.size ? "none" : "grid";
}

function removeInlineComment(line) {
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < line.length - 1; i += 1) {
    const c = line[i];
    const n = line[i + 1];
    if ((c === '"' || c === "'") && line[i - 1] !== "\\") {
      if (!inQuote) {
        inQuote = true;
        quoteChar = c;
      } else if (quoteChar === c) {
        inQuote = false;
      }
    }
    if (!inQuote && c === "/" && n === "/") {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function parseBlockBody(rawLines) {
  const fields = [];
  const modelOptions = [];

  rawLines.forEach((line) => {
    const withoutComments = removeInlineComment(line).trim();
    if (!withoutComments) return;
    if (withoutComments.startsWith("@@")) {
      modelOptions.push(withoutComments);
      return;
    }
    if (withoutComments.startsWith("//")) return;

    const fieldMatch = withoutComments.match(/^(\w+)\s+([^\s]+)(.*)$/);
    if (!fieldMatch) return;
    const name = fieldMatch[1];
    const type = fieldMatch[2];
    const tail = fieldMatch[3] || "";
    const attributes = tail.match(/@\w+(?:\([^)]*\))?/g) || [];
    fields.push({ name, type, attributes, raw: withoutComments });
  });

  return { fields, modelOptions };
}

function parsePrismaSchema(rawSchema) {
  const lines = rawSchema.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = removeInlineComment(lines[i]).trim();
    const startMatch = line.match(/^(datasource|generator|model|enum)\s+(\w+)\s*\{/);
    if (!startMatch) continue;

    const kind = startMatch[1];
    const name = startMatch[2];
    const body = [];

    let depth = 1;
    for (i = i + 1; i < lines.length; i += 1) {
      const current = lines[i];
      const openCount = (current.match(/\{/g) || []).length;
      const closeCount = (current.match(/\}/g) || []).length;
      depth += openCount;
      depth -= closeCount;
      if (depth <= 0) break;
      body.push(current);
    }

    blocks.push({ kind, name, body });
  }

  const datasources = blocks.filter((b) => b.kind === "datasource");
  const generators = blocks.filter((b) => b.kind === "generator");
  const enumBlocks = blocks.filter((b) => b.kind === "enum");
  const modelBlocks = blocks.filter((b) => b.kind === "model");

  const models = modelBlocks.map((block) => {
    const parsed = parseBlockBody(block.body);
    return {
      kind: block.kind,
      name: block.name,
      fields: parsed.fields,
      modelOptions: parsed.modelOptions,
      relations: [],
    };
  });

  const modelNameSet = new Set(models.map((m) => m.name));
  models.forEach((model) => {
    model.fields.forEach((field) => {
      const baseType = field.type.replace(/[\[\]?]/g, "");
      field.isRelation = modelNameSet.has(baseType);
      if (modelNameSet.has(baseType)) {
        model.relations.push({ field: field.name, to: baseType, type: field.type });
      }
    });
  });

  const totalFields = models.reduce((sum, m) => sum + m.fields.length, 0);
  const totalOptions = models.reduce((sum, m) => sum + m.modelOptions.length, 0);
  const totalRelations = models.reduce((sum, m) => sum + m.relations.length, 0);
  const largestModel = models
    .slice()
    .sort((a, b) => b.fields.length - a.fields.length)[0];

  return {
    raw: rawSchema,
    blocks,
    datasources,
    generators,
    enums: enumBlocks,
    models,
    info: {
      lines: lines.length,
      models: models.length,
      enums: enumBlocks.length,
      generators: generators.length,
      datasources: datasources.length,
      totalFields,
      totalOptions,
      totalRelations,
      largestModel: largestModel
        ? `${largestModel.name} (${largestModel.fields.length} fields)`
        : "n/a",
    },
  };
}

function estimateNodeHeight(model) {
  const fieldCount = Math.min(model.fields.length, 18);
  const optionsCount = model.modelOptions.length;
  return 92 + fieldCount * 25 + optionsCount * 22;
}

function createAutoLayout(models, center) {
  const positions = {};
  if (!models.length) return positions;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  models.forEach((model, index) => {
    const nodeHeight = estimateNodeHeight(model);
    const radius = SPIRAL_SPACING * Math.sqrt(index);
    const angle = index * goldenAngle;
    const x = center.x + Math.cos(angle) * radius - NODE_WIDTH / 2;
    const y = center.y + Math.sin(angle) * radius - nodeHeight / 2;

    positions[model.name] = {
      x,
      y,
      width: NODE_WIDTH,
      height: nodeHeight,
    };
  });

  return positions;
}

function getVisibleModels() {
  if (!state.parsed) return [];
  return state.parsed.models.filter((model) => state.selectedModels.has(model.name));
}

function renderInfo(info) {
  const items = [
    ["Lines", info.lines],
    ["Models", info.models],
    ["Enums", info.enums],
    ["Datasources", info.datasources],
    ["Generators", info.generators],
    ["Fields", info.totalFields],
    ["Model Options", info.totalOptions],
    ["Relations", info.totalRelations],
    ["Largest Model", info.largestModel],
  ];

  schemaInfo.innerHTML = "";
  items.forEach(([label, value]) => {
    const wrap = document.createElement("div");
    wrap.className = "info-item";
    const labelEl = document.createElement("span");
    labelEl.className = "label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "value";
    valueEl.textContent = String(value);
    wrap.append(labelEl, valueEl);
    schemaInfo.appendChild(wrap);
  });
}

function renderModelSelectionPanel() {
  modelList.innerHTML = "";

  if (!state.parsed || !state.parsed.models.length) {
    modelSelectionHint.textContent = "Load a schema to choose models.";
    return;
  }

  const orderedModels = state.parsed.models.slice().sort((a, b) => a.name.localeCompare(b.name));
  const filteredModels = orderedModels.filter((model) =>
    model.name.toLowerCase().includes(state.modelSearchQuery.toLowerCase())
  );
  modelSelectionHint.textContent = `${state.selectedModels.size} of ${orderedModels.length} selected (${filteredModels.length} shown)`;

  filteredModels.forEach((model) => {
    const row = document.createElement("label");
    row.className = "model-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.selectedModels.has(model.name);
    input.dataset.model = model.name;

    input.addEventListener("change", () => {
      if (input.checked) {
        state.selectedModels.add(model.name);
      } else {
        state.selectedModels.delete(model.name);
      }
      modelSelectionHint.textContent = `${state.selectedModels.size} of ${orderedModels.length} selected`;
      renderGraph();
      if (input.checked) fitView();
    });

    const text = document.createElement("span");
    text.textContent = model.name;
    row.append(input, text);
    modelList.appendChild(row);
  });
}

function getFieldVisibility(modelName) {
  if (!state.fieldVisibilityByModel[modelName]) {
    state.fieldVisibilityByModel[modelName] = {
      showRelations: false,
      showOthers: true,
    };
  }
  return state.fieldVisibilityByModel[modelName];
}

function addHiddenRelationToGraph(sourceModel, relation, sourcePos, slotIndex) {
  const x1 = sourcePos.x + sourcePos.width;
  const y1 = sourcePos.y + 28 + slotIndex * 18;
  const x2 = x1 + 138;
  const y2 = y1;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${x1} ${y1} L ${x2} ${y2}`);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "var(--edge)");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-dasharray", "6 5");
  path.setAttribute("opacity", "0.8");
  edgeLayer.appendChild(path);

  const revealBtn = document.createElement("button");
  revealBtn.type = "button";
  revealBtn.className = "hidden-relation-link";
  revealBtn.textContent = `... ${relation.to}`;
  revealBtn.style.left = `${x2 + 8}px`;
  revealBtn.style.top = `${y2 - 10}px`;

  revealBtn.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });

  revealBtn.addEventListener("click", (event) => {
    event.stopPropagation();

    if (!state.selectedModels.has(relation.to)) {
      state.selectedModels.add(relation.to);
    }

    const targetPos = state.nodePositions[relation.to];
    if (targetPos) {
      targetPos.x = x2 + 56;
      targetPos.y = y2 - targetPos.height / 2;
    }

    renderModelSelectionPanel();
    renderGraph();
    fitView();
    setStatus(`Revealed related model ${relation.to} from ${sourceModel}.`);
  });

  relationStubLayer.appendChild(revealBtn);
}

function getRelationEdgeLabel(sideA, sideB) {
  const aList = sideA && sideA.isList;
  const bList = sideB && sideB.isList;
  let kind = "1:1";
  if (aList && bList) {
    kind = "N:M";
  } else if (aList || bList) {
    kind = "1:N";
  }

  const optional = (sideA && sideA.isOptional) || (sideB && sideB.isOptional);
  return optional ? `${kind} (optional)` : kind;
}

function renderEdges(visibleModels) {
  edgeLayer.innerHTML = "";
  relationStubLayer.innerHTML = "";

  const visibleSet = new Set(visibleModels.map((m) => m.name));
  const modelMap = new Map(visibleModels.map((m) => [m.name, m]));

  const relationMap = new Map();

  visibleModels.forEach((model) => {
    const fromPos = state.nodePositions[model.name];
    if (!fromPos) return;

    let hiddenSlot = 0;
    model.relations.forEach((relation) => {
      if (!visibleSet.has(relation.to)) {
        addHiddenRelationToGraph(model.name, relation, fromPos, hiddenSlot);
        hiddenSlot += 1;
        return;
      }

      const key = model.name < relation.to ? `${model.name}::${relation.to}` : `${relation.to}::${model.name}`;
      const entry = relationMap.get(key) || {
        models: [model.name, relation.to].sort(),
        sides: {},
      };
      entry.sides[model.name] = {
        isList: relation.type.includes("[]"),
        isOptional: relation.type.includes("?") && !relation.type.includes("[]"),
      };
      relationMap.set(key, entry);
    });
  });

  relationMap.forEach((entry) => {
    const [modelA, modelB] = entry.models;
    const modelPosA = state.nodePositions[modelA];
    const modelPosB = state.nodePositions[modelB];
    if (!modelPosA || !modelPosB) return;

    const x1 = modelPosA.x + modelPosA.width;
    const y1 = modelPosA.y + modelPosA.height / 2;
    const x2 = modelPosB.x;
    const y2 = modelPosB.y + modelPosB.height / 2;
    const bend = Math.max(40, Math.abs(x2 - x1) * 0.45);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--edge)");
    path.setAttribute("stroke-width", "1.3");
    path.setAttribute("opacity", "0.7");
    edgeLayer.appendChild(path);

    const label = getRelationEdgeLabel(entry.sides[modelA], entry.sides[modelB]);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "edge-label");
    text.setAttribute("x", String((x1 + x2) / 2));
    text.setAttribute("y", String((y1 + y2) / 2 - 6));
    text.textContent = label;
    edgeLayer.appendChild(text);
  });
}

function createFieldItem(field) {
  const li = document.createElement("li");
  const isNullable = field.type.includes("?");
  if (isNullable) {
    li.classList.add("field-nullable");
  }

  const line = document.createElement("span");
  line.className = "field-line";
  line.textContent = `${field.name}: ${field.type}`;

  if (isNullable) {
    const nullableTag = document.createElement("span");
    nullableTag.className = "nullable-tag";
    nullableTag.textContent = "nullable";
    line.appendChild(nullableTag);
  }

  li.appendChild(line);

  if (field.attributes.length) {
    const attrs = document.createElement("span");
    attrs.className = "field-attrs";
    attrs.textContent = field.attributes.join(" ");
    li.appendChild(attrs);
  }

  return li;
}

function renderNodes(visibleModels) {
  if (state.resizeObserver) {
    state.resizeObserver.disconnect();
  }

  state.resizeObserver = new ResizeObserver((entries) => {
    let needsEdgeRefresh = false;
    entries.forEach((entry) => {
      const modelName = entry.target.dataset.model;
      const pos = state.nodePositions[modelName];
      if (!pos) return;
      const nextHeight = entry.contentRect.height;
      if (Math.abs(pos.height - nextHeight) > 1) {
        pos.height = nextHeight;
        needsEdgeRefresh = true;
      }
    });

    if (needsEdgeRefresh) {
      renderEdges(getVisibleModels());
    }
  });

  nodeLayer.innerHTML = "";

  visibleModels.forEach((model) => {
    const pos = state.nodePositions[model.name];
    if (!pos) return;

    const node = document.createElement("article");
    node.className = "schema-node";
    node.dataset.model = model.name;
    node.style.left = `${pos.x}px`;
    node.style.top = `${pos.y}px`;

    const head = document.createElement("div");
    head.className = "node-head";
    const title = document.createElement("h3");
    title.className = "node-title";
    title.textContent = model.name;
    head.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "node-close";
    closeBtn.setAttribute("aria-label", `Hide ${model.name}`);
    closeBtn.textContent = "x";
    closeBtn.addEventListener("mousedown", (event) => event.stopPropagation());
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedModels.delete(model.name);
      renderModelSelectionPanel();
      renderGraph();
    });
    head.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "node-body";

    const visibility = getFieldVisibility(model.name);
    const toggleRow = document.createElement("div");
    toggleRow.className = "node-field-toggles";
    toggleRow.addEventListener("mousedown", (event) => event.stopPropagation());

    const relationToggle = document.createElement("label");
    relationToggle.className = "node-field-toggle";
    const relationInput = document.createElement("input");
    relationInput.type = "checkbox";
    relationInput.checked = visibility.showRelations;
    relationInput.addEventListener("mousedown", (event) => event.stopPropagation());
    relationInput.addEventListener("change", () => {
      visibility.showRelations = relationInput.checked;
      renderGraph();
    });
    const relationText = document.createElement("span");
    relationText.textContent = "Show relation fields";
    relationToggle.append(relationInput, relationText);

    const otherToggle = document.createElement("label");
    otherToggle.className = "node-field-toggle";
    const otherInput = document.createElement("input");
    otherInput.type = "checkbox";
    otherInput.checked = visibility.showOthers;
    otherInput.addEventListener("mousedown", (event) => event.stopPropagation());
    otherInput.addEventListener("change", () => {
      visibility.showOthers = otherInput.checked;
      renderGraph();
    });
    const otherText = document.createElement("span");
    otherText.textContent = "Show other fields";
    otherToggle.append(otherInput, otherText);

    toggleRow.append(relationToggle, otherToggle);
    body.appendChild(toggleRow);

    const filteredFields = model.fields.filter((field) => {
      if (field.isRelation) return visibility.showRelations;
      return visibility.showOthers;
    });

    const fieldsTitle = document.createElement("p");
    fieldsTitle.className = "node-subtitle";
    fieldsTitle.textContent = `Fields (${filteredFields.length}/${model.fields.length})`;
    body.appendChild(fieldsTitle);

    const fieldList = document.createElement("ul");
    fieldList.className = "field-list";
    filteredFields.forEach((field) => fieldList.appendChild(createFieldItem(field)));
    body.appendChild(fieldList);

    const optionsTitle = document.createElement("p");
    optionsTitle.className = "node-subtitle";
    optionsTitle.textContent = `Model Options (${model.modelOptions.length})`;
    body.appendChild(optionsTitle);

    const optionsWrap = document.createElement("div");
    optionsWrap.className = "model-options";
    if (!model.modelOptions.length) {
      const emptyChip = document.createElement("span");
      emptyChip.className = "option-chip";
      emptyChip.textContent = "none";
      optionsWrap.appendChild(emptyChip);
    } else {
      model.modelOptions.forEach((option) => {
        const chip = document.createElement("span");
        chip.className = "option-chip";
        chip.textContent = option;
        optionsWrap.appendChild(chip);
      });
    }
    body.appendChild(optionsWrap);

    node.append(head, body);
    nodeLayer.appendChild(node);
    state.resizeObserver.observe(node);
  });

  renderEdges(visibleModels);
}

function renderGraph() {
  const visibleModels = getVisibleModels();
  renderNodes(visibleModels);
  updateEmptyState();
}

function updateViewTransform() {
  stage.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
}

function centerViewOnWorldPoint(point, scale = state.view.scale) {
  const rect = viewport.getBoundingClientRect();
  state.view.scale = scale;
  state.view.x = rect.width / 2 - point.x * scale;
  state.view.y = rect.height / 2 - point.y * scale;
  updateViewTransform();
}

function fitView() {
  const visibleModels = getVisibleModels();
  if (!visibleModels.length) {
    setStatus("Select at least one model to fit the graph.");
    return;
  }

  const positions = visibleModels
    .map((model) => state.nodePositions[model.name])
    .filter(Boolean);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  positions.forEach((p) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.width);
    maxY = Math.max(maxY, p.y + p.height);
  });

  const boundsWidth = maxX - minX + 140;
  const boundsHeight = maxY - minY + 140;
  const rect = viewport.getBoundingClientRect();

  const scaleX = rect.width / boundsWidth;
  const scaleY = rect.height / boundsHeight;
  const scale = Math.min(1.2, Math.max(0.2, Math.min(scaleX, scaleY)));

  state.view.scale = scale;
  state.view.x = (rect.width - boundsWidth * scale) / 2 - (minX - 70) * scale;
  state.view.y = (rect.height - boundsHeight * scale) / 2 - (minY - 70) * scale;
  updateViewTransform();
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark-mode", isDark);
  darkModeToggle.checked = isDark;
}

function initializeTheme() {
  const stored = localStorage.getItem("prisma-theme");
  applyTheme(stored === "dark" ? "dark" : "light");
}

function renderParsedSchema(parsed, sourceLabel) {
  state.parsed = parsed;
  state.nodePositions = createAutoLayout(parsed.models, WORLD_CENTER);
  state.selectedModels = new Set();
  state.fieldVisibilityByModel = {};
  state.modelSearchQuery = "";
  modelSearchInput.value = "";
  centerViewOnWorldPoint(WORLD_CENTER, 0.85);
  renderInfo(parsed.info);
  renderModelSelectionPanel();
  renderGraph();
  setStatus(
    `Loaded ${sourceLabel}: ${parsed.info.models} models found. Pick models from the selection panel.`
  );
}

function loadSchemaText(rawText, sourceLabel) {
  try {
    const parsed = parsePrismaSchema(rawText);
    renderParsedSchema(parsed, sourceLabel);
  } catch (error) {
    setStatus(`Failed to parse schema: ${error.message}`, true);
  }
}

function readLocalFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    loadSchemaText(String(reader.result || ""), file.name);
  };
  reader.onerror = () => {
    setStatus("Could not read the selected file.", true);
  };
  reader.readAsText(file);
}

function loadDemoSchema() {
  loadSchemaText(DEMO_SCHEMA, "demo schema");
  if (!state.parsed) return;
  state.selectedModels = new Set(state.parsed.models.map((model) => model.name));
  renderModelSelectionPanel();
  renderGraph();
  fitView();
}

schemaInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  readLocalFile(file);
});

loadExampleBtn.addEventListener("click", async () => {
  try {
    const response = await fetch("schema.prisma", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    loadSchemaText(text, "schema.prisma");
  } catch (error) {
    setStatus("Could not load schema.prisma automatically. Use the file picker.", true);
  }
});

fitViewBtn.addEventListener("click", () => {
  fitView();
});

selectAllModelsBtn.addEventListener("click", () => {
  if (!state.parsed) return;
  state.selectedModels = new Set(state.parsed.models.map((m) => m.name));
  renderModelSelectionPanel();
  renderGraph();
  fitView();
});

clearModelsBtn.addEventListener("click", () => {
  state.selectedModels = new Set();
  renderModelSelectionPanel();
  renderGraph();
});

modelSearchInput.addEventListener("input", () => {
  state.modelSearchQuery = modelSearchInput.value.trim();
  renderModelSelectionPanel();
});

darkModeToggle.addEventListener("change", () => {
  const theme = darkModeToggle.checked ? "dark" : "light";
  applyTheme(theme);
  localStorage.setItem("prisma-theme", theme);
});

viewport.addEventListener(
  "wheel",
  (event) => {
    const scrollHost = event.target.closest(".node-body");
    if (scrollHost && scrollHost.scrollHeight > scrollHost.clientHeight) {
      return;
    }

    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const oldScale = state.view.scale;
    const zoomFactor = event.deltaY < 0 ? 1.08 : 0.92;
    const newScale = Math.max(0.18, Math.min(2.8, oldScale * zoomFactor));

    const worldX = (px - state.view.x) / oldScale;
    const worldY = (py - state.view.y) / oldScale;

    state.view.scale = newScale;
    state.view.x = px - worldX * newScale;
    state.view.y = py - worldY * newScale;
    updateViewTransform();
  },
  { passive: false }
);

viewport.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  if (event.target.closest(".hidden-relation-link")) return;
  const node = event.target.closest(".schema-node");

  if (node) {
    event.preventDefault();
    const modelName = node.dataset.model;
    const pos = state.nodePositions[modelName];
    if (!pos) return;
    state.interaction = {
      mode: "move-node",
      modelName,
      startX: event.clientX,
      startY: event.clientY,
      originalX: pos.x,
      originalY: pos.y,
    };
  } else {
    state.interaction = {
      mode: "pan",
      startX: event.clientX,
      startY: event.clientY,
      originalX: state.view.x,
      originalY: state.view.y,
    };
  }
});

window.addEventListener("mousemove", (event) => {
  if (!state.interaction) return;

  if (state.interaction.mode === "pan") {
    const dx = event.clientX - state.interaction.startX;
    const dy = event.clientY - state.interaction.startY;
    state.view.x = state.interaction.originalX + dx;
    state.view.y = state.interaction.originalY + dy;
    updateViewTransform();
    return;
  }

  if (state.interaction.mode === "move-node") {
    const { modelName } = state.interaction;
    const pos = state.nodePositions[modelName];
    if (!pos) return;

    const dx = (event.clientX - state.interaction.startX) / state.view.scale;
    const dy = (event.clientY - state.interaction.startY) / state.view.scale;
    pos.x = state.interaction.originalX + dx;
    pos.y = state.interaction.originalY + dy;

    const node = nodeLayer.querySelector(`[data-model="${modelName}"]`);
    if (node) {
      node.style.left = `${pos.x}px`;
      node.style.top = `${pos.y}px`;
    }
    renderEdges(getVisibleModels());
  }
});

window.addEventListener("mouseup", () => {
  state.interaction = null;
});

initializeTheme();
loadDemoSchema();
