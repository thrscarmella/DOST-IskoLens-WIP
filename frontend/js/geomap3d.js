/* ==========================================================================
   DOST-IskoLens — 3D GeoMap (D3.js)
   Draws the 11 municipalities of Davao Oriental from their real PSA
   boundaries (GeoJSON) as raised blocks on a tilted plane. Each block's
   height and colour follow the selected metric (e.g. number of scholars).

   Usage:
     const map = await IskoGeoMap.create(element, {
       data,            // /api/geomap municipalities array
       metric: 'total', // total | active | graduated | terminated | below_requirement
       compact: false,  // true on the dashboard: no zoom/controls
       onSelect: name => {}
     });
     map.setMetric('active'); map.setData(newData); map.select('Lupon');
     map.setView('tilted' | 'flat'); map.zoomBy(1.3); map.resetZoom();

   Boundaries: faeldon/philippines-json-maps (MIT), PSGC 2023.
   ========================================================================== */
const IskoGeoMap = (function () {
  const GEO_URL = '../assets/geo/davao-oriental-municipalities.geojson';
  const CONTEXT_URL = '../assets/geo/davao-de-oro-municipalities.geojson';
  const NAME_FIX = { 'City of Mati': 'Mati City' };
  const METRIC_LABELS = {
    total: 'Total scholars', active: 'Active scholars', graduated: 'Graduated',
    terminated: 'Terminated', below_requirement: 'Below GWA requirement',
    acceptance_rate: 'Acceptance rate (%)', priority_score: 'Outreach priority score'
  };
  const LOW = '#203a72', HIGH = '#5fd0ff', BELOW_HIGH = '#ffb347', EMPTY = '#1a2a52';
  let geoCache = null;

  /* The boundary files follow the GeoJSON standard's counter-clockwise ring
     order, but D3 expects clockwise rings on the sphere. Rings in the wrong
     direction would be read as "the whole globe except this polygon", so any
     feature whose spherical area is more than a hemisphere gets reversed. */
  function rewind(fc) {
    if (!fc) return fc;
    fc.features.forEach(f => {
      if (d3.geoArea(f) > 2 * Math.PI) {
        const g = f.geometry;
        if (g.type === 'Polygon') g.coordinates = g.coordinates.map(r => r.slice().reverse());
        if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map(p => p.map(r => r.slice().reverse()));
      }
    });
    return fc;
  }

  function loadGeo() {
    if (!geoCache) {
      geoCache = Promise.all([
        fetch(GEO_URL).then(r => r.json()).then(rewind),
        fetch(CONTEXT_URL).then(r => r.json()).then(rewind).catch(() => null)
      ]);
    }
    return geoCache;
  }

  async function create(container, opts) {
    const [province, context] = await loadGeo();
    province.features.forEach(f => { f.properties.label = NAME_FIX[f.properties.name] || f.properties.name; });

    const state = {
      data: opts.data || [], metric: opts.metric || 'total', view: opts.view || 'tilted',
      selected: null, compact: !!opts.compact
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const W = 620, H = state.compact ? 600 : 640;

    container.classList.add('geo3d');
    container.innerHTML = '';
    const svg = d3.select(container).append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'group')
      .attr('aria-label', 'Map of Davao Oriental municipalities. Use Tab to move between municipalities and Enter to select one.');
    const defs = svg.append('defs');
    defs.append('filter').attr('id', 'geo3d-shadow').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%')
      .append('feGaussianBlur').attr('stdDeviation', 5);
    const glow = defs.append('filter').attr('id', 'geo3d-glow');
    glow.append('feGaussianBlur').attr('stdDeviation', 2.2).attr('result', 'b');
    // Hover highlight: a soft cyan halo around the lifted municipality.
    const halo = defs.append('filter').attr('id', 'geo3d-hover-glow')
      .attr('x', '-30%').attr('y', '-30%').attr('width', '160%').attr('height', '160%');
    halo.append('feDropShadow').attr('dx', 0).attr('dy', 0).attr('stdDeviation', 7)
      .attr('flood-color', '#7fe3ff').attr('flood-opacity', 0.95);
    halo.append('feDropShadow').attr('dx', 0).attr('dy', 14).attr('stdDeviation', 9)
      .attr('flood-color', '#000814').attr('flood-opacity', 0.75);
    const merge = glow.append('feMerge');
    merge.append('feMergeNode').attr('in', 'b');
    merge.append('feMergeNode').attr('in', 'SourceGraphic');

    const zoomLayer = svg.append('g');
    const tooltip = d3.select(container).append('div').attr('class', 'geo3d-tooltip').style('opacity', 0);
    const legend = d3.select(container).append('div').attr('class', 'geo3d-legend');

    let zoom = null;
    if (!state.compact) {
      zoom = d3.zoom().scaleExtent([1, 6]).translateExtent([[-W * 0.3, -H * 0.3], [W * 1.3, H * 1.3]])
        .on('zoom', ev => zoomLayer.attr('transform', ev.transform));
      svg.call(zoom).on('dblclick.zoom', null);
    }

    const byName = () => {
      const m = {};
      state.data.forEach(d => { m[d.name] = d; if (d.psgc) m['psgc:' + d.psgc] = d; });
      return m;
    };
    const valueOf = f => {
      const lookup = byName();
      const d = lookup['psgc:' + f.properties.psgc] || lookup[f.properties.label];
      return d ? (Number(d[state.metric]) || 0) : 0;
    };
    const recordOf = f => {
      const lookup = byName();
      return lookup['psgc:' + f.properties.psgc] || lookup[f.properties.label] || null;
    };

    function draw() {
      const tilted = state.view === 'tilted';
      const tilt = tilted ? 0.66 : 1;          // vertical squash = viewing angle
      const maxH = tilted ? (state.compact ? 26 : 34) : 3;
      const pad = 26;

      // Fit Mercator to the province, then squash y to fake a tilted plane.
      const base = d3.geoMercator().fitExtent([[pad, pad], [W - pad, (H - pad - maxH) / tilt]], province);
      const yOffset = tilted ? maxH + 4 : 0;   // room for the tallest block
      const proj = d3.geoTransform({
        point(x, y) { const p = base([x, y]); this.stream.point(p[0], p[1] * tilt + yOffset); }
      });
      const path = d3.geoPath(proj);

      // Crop the view box to the drawn province (plus room for block height,
      // labels and the legend) so the map fills its panel.
      const [[bx0, by0], [bx1, by1]] = path.bounds(province);
      const m = 18;
      const legendRoom = state.compact ? 0 : 60;
      svg.attr('viewBox', `${bx0 - m - legendRoom} ${by0 - maxH - m - 14} ${bx1 - bx0 + 2 * m + legendRoom} ${by1 - by0 + maxH + 2 * m + 14}`);

      const values = province.features.map(valueOf);
      const max = Math.max(1, d3.max(values));
      const high = state.metric === 'below_requirement' || state.metric === 'terminated' ? BELOW_HIGH : HIGH;
      const color = d3.scaleSequential(d3.interpolateRgb(LOW, high)).domain([0, max]);
      const height = v => (tilted ? 4 : 1) + (v / max) * (maxH - (tilted ? 4 : 1));

      zoomLayer.selectAll('*').remove();

      // Neighbouring province, faint, for geographic context.
      if (context) {
        zoomLayer.append('g').attr('class', 'geo3d-context').selectAll('path').data(context.features).join('path')
          .attr('d', path).attr('fill', 'rgba(120,150,210,0.06)').attr('stroke', 'rgba(150,180,240,0.16)').attr('stroke-width', 0.6);
      }

      // Soft ground shadow under the whole province.
      zoomLayer.append('g').attr('filter', 'url(#geo3d-shadow)').attr('opacity', tilted ? 0.55 : 0.25)
        .selectAll('path').data(province.features).join('path')
        .attr('d', path).attr('fill', '#02040b').attr('transform', `translate(${tilted ? 6 : 2},${tilted ? 10 : 3})`);

      // Draw north to south so southern blocks overlap the ones behind them.
      const features = province.features.slice().sort((a, b) => path.centroid(a)[1] - path.centroid(b)[1]);

      const blocks = zoomLayer.append('g').attr('class', 'geo3d-blocks').selectAll('g.geo3d-muni').data(features).join('g')
        .attr('class', 'geo3d-muni')
        .attr('tabindex', state.compact ? null : 0)
        .attr('role', 'button')
        .attr('aria-label', f => `${f.properties.label}: ${valueOf(f)} ${METRIC_LABELS[state.metric].toLowerCase()}`)
        .classed('is-selected', f => f.properties.label === state.selected);

      blocks.each(function (f) {
        const g = d3.select(this);
        const v = valueOf(f);
        const h = Math.round(height(v));
        const top = v ? color(v) : EMPTY;
        const side = d3.color(top).darker(1.5);
        const d = path(f);
        const lift = g.append('g').attr('class', 'geo3d-lift');
        // Side walls: the outline stacked 1px at a time from the ground up.
        const sides = lift.append('g').attr('class', 'geo3d-sides');
        for (let i = 0; i < h; i++) {
          sides.append('path').attr('d', d).attr('transform', `translate(0,${-i})`)
            .attr('fill', d3.interpolateRgb(side.darker(0.6), side)(i / Math.max(h, 1)));
        }
        lift.append('path').attr('class', 'geo3d-top').attr('d', d).attr('transform', `translate(0,${-h})`)
          .attr('fill', top).attr('stroke', 'rgba(220,235,255,0.55)').attr('stroke-width', 0.8);
        f._h = h;
        f._d = d;
        f._top = top;
        f._side = side;
      });

      // Labels sit on top of each block and are never squashed.
      const labels = zoomLayer.append('g').attr('class', 'geo3d-labels').selectAll('g').data(features).join('g')
        .attr('class', 'geo3d-label')
        .attr('transform', f => { const [x, y] = path.centroid(f); return `translate(${x},${y - f._h})`; });
      labels.filter(f => f.properties.label === 'Mati City').append('circle')
        .attr('r', 5.5).attr('cy', -18).attr('fill', '#fbbf24').attr('stroke', '#fff7d6').attr('stroke-width', 1.5)
        .attr('filter', 'url(#geo3d-glow)');
      labels.append('text').attr('class', 'geo3d-name').attr('text-anchor', 'middle').attr('y', -3)
        .text(f => f.properties.label);
      labels.append('text').attr('class', 'geo3d-value').attr('text-anchor', 'middle').attr('y', 10)
        .text(f => valueOf(f));

      // Interaction ---------------------------------------------------------
      // Hovering lifts the municipality well above the others with a slight
      // overshoot, extends its walls down to the ground so it reads as a
      // solid raised block, brightens and outlines it with a glow, and dims
      // every other municipality. The info card is placed beside the block,
      // outside its outline, so it never covers the municipality itself.
      const LIFT = tilted ? (state.compact ? 22 : 30) : 8;
      const labelOf = f => labels.filter(l => l === f);
      const labelPos = (f, up) => { const [x, y] = path.centroid(f); return `translate(${x},${y - f._h - up})`; };

      function placeTooltip(node, f) {
        const r = recordOf(f) || {};
        tooltip.html(`<div class="tt-name">${esc(f.properties.label)}${f.properties.label === 'Mati City' ? ' (Capital)' : ''}</div>
          <div class="tt-row"><span>Total scholars</span><b>${r.total || 0}</b></div>
          <div class="tt-row"><span>Active</span><b>${r.active || 0}</b></div>
          <div class="tt-row"><span>Graduated</span><b>${r.graduated || 0}</b></div>
          <div class="tt-row"><span>Below GWA requirement</span><b>${r.below_requirement || 0}</b></div>`);
        const c = container.getBoundingClientRect();
        const box = node.querySelector('.geo3d-top').getBoundingClientRect();
        // Where the block will be once fully lifted (screen pixels).
        const vb = svg.attr('viewBox').split(' ').map(Number);
        const pxPerUnit = svg.node().getBoundingClientRect().height / vb[3];
        const zoomK = zoom ? d3.zoomTransform(svg.node()).k : 1;
        const top = box.top - LIFT * pxPerUnit * zoomK;
        const tt = tooltip.node();
        const zoomed = c.width / (container.offsetWidth || c.width) || 1;
        const tw = tt.offsetWidth * zoomed, th = tt.offsetHeight * zoomed, gap = 16, pad = 8;
        let x, y;
        if (box.right - c.left + gap + tw <= c.width - pad) {          // room on the right
          x = box.right - c.left + gap;
        } else if (box.left - c.left - gap - tw >= pad) {              // room on the left
          x = box.left - c.left - gap - tw;
        } else {                                                      // neither: above or below the block
          x = Math.min(Math.max(box.left - c.left + box.width / 2 - tw / 2, pad), c.width - tw - pad);
          y = top - c.top - th - gap >= pad ? top - c.top - th - gap : box.bottom - c.top + gap;
        }
        if (y === undefined) {
          y = Math.min(Math.max(top - c.top + (box.bottom - top) / 2 - th / 2, pad), c.height - th - pad);
        }
        // The app can zoom the whole page (font size / screen scaling), so
        // measured pixels are converted back to the container's own units.
        const scale = c.width / (container.offsetWidth || c.width) || 1;
        tooltip.style('left', (x / scale) + 'px').style('top', (y / scale) + 'px').classed('is-visible', true).style('opacity', 1);
      }

      function raiseBlock(node, f) {
        const g = d3.select(node).raise();
        const lift = g.select('.geo3d-lift');
        // Extra wall layers fill the gap between the lifted block and the ground.
        lift.selectAll('.geo3d-extra').remove();
        const extra = lift.insert('g', ':first-child').attr('class', 'geo3d-extra');
        for (let k = 1; k <= LIFT; k++) {
          extra.append('path').attr('d', f._d).attr('transform', `translate(0,${k})`)
            .attr('fill', d3.interpolateRgb(f._side.darker(1.1), f._side.darker(0.4))(1 - k / LIFT))
            .style('opacity', 0);
        }
        const walls = extra.selectAll('path').nodes();
        lift.select('.geo3d-top').interrupt()
          .attr('filter', 'url(#geo3d-hover-glow)')
          .transition().duration(reduceMotion ? 0 : 260)
          .attr('fill', d3.color(f._top).brighter(0.75)).attr('stroke', '#ffffff').attr('stroke-width', 1.8);
        lift.interrupt().transition('lift').duration(reduceMotion ? 0 : 520)
          .ease(reduceMotion ? d3.easeLinear : d3.easeBackOut.overshoot(1.7))
          .tween('lift', () => t => {
            const up = LIFT * t;
            lift.attr('transform', `translate(0,${-up})`);
            const shown = Math.max(0, Math.round(up));
            walls.forEach((w, i) => { w.style.opacity = i < shown ? 1 : 0; });
          });
        labelOf(f).raise().interrupt().transition().duration(reduceMotion ? 0 : 520)
          .ease(reduceMotion ? d3.easeLinear : d3.easeBackOut.overshoot(1.7))
          .attr('transform', labelPos(f, LIFT)).style('opacity', 1);
        labelOf(f).classed('is-hovered', true);
        // Dim everything else so the raised municipality stands out.
        blocks.filter(o => o !== f).interrupt('dim').transition('dim').duration(reduceMotion ? 0 : 240).style('opacity', 0.35);
        labels.filter(o => o !== f).interrupt('dim').transition('dim').duration(reduceMotion ? 0 : 240).style('opacity', 0.35);
        placeTooltip(node, f);
      }

      function lowerBlock(node, f) {
        const lift = d3.select(node).select('.geo3d-lift');
        const walls = lift.selectAll('.geo3d-extra path').nodes();
        lift.select('.geo3d-top').interrupt().attr('filter', null)
          .transition().duration(reduceMotion ? 0 : 220)
          .attr('fill', f._top).attr('stroke', 'rgba(220,235,255,0.55)').attr('stroke-width', 0.8);
        const from = (() => { const m = /translate\(0,(-?[\d.]+)\)/.exec(lift.attr('transform') || ''); return m ? -parseFloat(m[1]) : 0; })();
        lift.interrupt('lift').transition('lift').duration(reduceMotion ? 0 : 300).ease(d3.easeCubicOut)
          .tween('lift', () => t => {
            const up = from * (1 - t);
            lift.attr('transform', `translate(0,${-up})`);
            const shown = Math.max(0, Math.round(up));
            walls.forEach((w, i) => { w.style.opacity = i < shown ? 1 : 0; });
          })
          .on('end', () => lift.selectAll('.geo3d-extra').remove());
        labelOf(f).classed('is-hovered', false).interrupt().transition().duration(reduceMotion ? 0 : 300)
          .ease(d3.easeCubicOut).attr('transform', labelPos(f, 0));
        tooltip.classed('is-visible', false).style('opacity', 0);
      }

      function restoreOthers() {
        blocks.interrupt('dim').transition('dim').duration(reduceMotion ? 0 : 240).style('opacity', 1);
        labels.interrupt('dim').transition('dim').duration(reduceMotion ? 0 : 240).style('opacity', 1);
      }

      blocks
        .on('mouseenter focus', function (ev, f) { raiseBlock(this, f); })
        .on('mouseleave blur', function (ev, f) { lowerBlock(this, f); restoreOthers(); })
        .on('click', (ev, f) => { select(f.properties.label); if (opts.onSelect) opts.onSelect(f.properties.label); })
        .on('keydown', (ev, f) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(f.properties.label); if (opts.onSelect) opts.onSelect(f.properties.label); } });

      // Legend
      legend.html(`<div class="geo3d-legend-title">${esc(METRIC_LABELS[state.metric])}</div>
        <div class="geo3d-legend-bar" style="background:linear-gradient(90deg, ${LOW}, ${high});"></div>
        <div class="geo3d-legend-scale"><span>0</span><span>${max}</span></div>
        <div class="geo3d-legend-cap"><span class="cap-dot"></span> Provincial capital</div>`);
    }

    function select(name) {
      state.selected = name;
      zoomLayer.selectAll('g.geo3d-muni').classed('is-selected', f => f.properties.label === name);
    }

    draw();

    return {
      setMetric(m) { state.metric = m; draw(); if (state.selected) select(state.selected); },
      setData(d) { state.data = d; draw(); if (state.selected) select(state.selected); },
      setView(view) { state.view = view; draw(); if (state.selected) select(state.selected); },
      select,
      zoomBy(k) { if (zoom) svg.transition().duration(250).call(zoom.scaleBy, k); },
      resetZoom() { if (zoom) svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity); },
      metricLabel: m => METRIC_LABELS[m]
    };
  }

  return { create, METRIC_LABELS };
})();
