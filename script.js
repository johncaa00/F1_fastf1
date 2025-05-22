// --- Configuración del Gráfico ---
const SVG_MARGIN = { top: 40, right: 130, bottom: 60, left: 50 };
let SVG_WIDTH = 1000 - SVG_MARGIN.left - SVG_MARGIN.right;
const SVG_HEIGHT = 600 - SVG_MARGIN.top - SVG_MARGIN.bottom;

const IDX_PROG_WINDOW_SIZE = 300; 
const IDX_PROG_FOCUS_OFFSET = 100; 

// --- Variables Globales de Estado ---
let raceData = null;
let animationFrameId = null;
let lastTimestamp = 0;
let currentRaceTimeSeconds = 0; 
let playbackSpeedFactor = 30; 
let isPlaying = false;

let xScale, yScale; 
let svg, chartGroup, xAxisGroup, yAxisGroup, linesGroup, labelsGroup, dotsGroup, gridLinesGroup, lapMarkerLinesGroup;

// --- Elementos del DOM ---
const raceTitleEl = document.getElementById('race-title');
const playPauseButton = document.getElementById('play-pause-button');
const timeSlider = document.getElementById('lap-slider'); 
const currentTimeDisplay = document.getElementById('current-lap-display'); 
const totalTimeDisplay = document.getElementById('total-laps-display'); 
const speedSlider = document.getElementById('speed-slider');

function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function initializeChart() {
    try {
        const response = await fetch('race_data.json');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        raceData = await response.json();
    } catch (error) { console.error("Error cargando race_data.json:", error); raceTitleEl.textContent = "Error cargando datos de la carrera."; return; }

    raceTitleEl.textContent = `${raceData.eventName} ${raceData.eventYear}`;
    totalTimeDisplay.textContent = formatTime(raceData.totalRaceTimeSeconds);
    timeSlider.max = raceData.totalRaceTimeSeconds;
    timeSlider.value = 0;
    currentTimeDisplay.textContent = formatTime(0);

    speedSlider.min = 1;
    speedSlider.max = 150; 
    speedSlider.value = playbackSpeedFactor;

    SVG_WIDTH = Math.max(800, window.innerWidth * 0.8 - SVG_MARGIN.left - SVG_MARGIN.right);

    svg = d3.select("#race-chart").attr("width", SVG_WIDTH + SVG_MARGIN.left + SVG_MARGIN.right).attr("height", SVG_HEIGHT + SVG_MARGIN.top + SVG_MARGIN.bottom);
    svg.append("defs").append("clipPath").attr("id", "clip").append("rect").attr("width", SVG_WIDTH).attr("height", SVG_HEIGHT);
    chartGroup = svg.append("g").attr("transform", `translate(${SVG_MARGIN.left},${SVG_MARGIN.top})`);

    gridLinesGroup = chartGroup.append("g").attr("class", "grid-lines-group");
    lapMarkerLinesGroup = chartGroup.append("g").attr("class", "lap-marker-lines-group").attr("clip-path", "url(#clip)");
    linesGroup = chartGroup.append("g").attr("class", "lines-group").attr("clip-path", "url(#clip)");
    dotsGroup = chartGroup.append("g").attr("class", "dots-group").attr("clip-path", "url(#clip)");
    labelsGroup = chartGroup.append("g").attr("class", "labels-group");
    xAxisGroup = chartGroup.append("g").attr("class", "x-axis axis").attr("transform", `translate(0,${SVG_HEIGHT})`);
    yAxisGroup = chartGroup.append("g").attr("class", "y-axis axis");

    xScale = d3.scaleLinear().range([0, SVG_WIDTH]);
    const numDrivers = raceData.driversData.length > 0 ? Math.max(...raceData.driversData.flatMap(d => d.laps.map(l => l.position)), 20) : 20;
    yScale = d3.scaleLinear().domain([0.5, numDrivers + 0.5]).range([0, SVG_HEIGHT]);

    yAxisGroup.call(d3.axisLeft(yScale).ticks(numDrivers).tickFormat(d3.format("d")));
    chartGroup.append("text").attr("class", "axis-label").attr("transform", "rotate(-90)").attr("y", 0 - SVG_MARGIN.left).attr("x", 0 - (SVG_HEIGHT / 2)).attr("dy", "0.71em").style("text-anchor", "middle").text("Position");
    chartGroup.append("text").attr("class", "axis-label").attr("x", SVG_WIDTH / 2).attr("y", SVG_HEIGHT + SVG_MARGIN.bottom - 15).style("text-anchor", "middle").text("Lap");
    gridLinesGroup.selectAll(".grid-line").data(d3.range(1, numDrivers + 1)).enter().append("line").attr("class", "grid-line").attr("x1", 0).attr("x2", SVG_WIDTH).attr("y1", d => yScale(d)).attr("y2", d => yScale(d));
    
    raceData.driversData.forEach(driver => {
        driver.getSnapshot = function(targetRaceTimeSec) {
            if (!this.laps || this.laps.length === 0) {
                // Si no hay datos de vueltas y el tiempo ha avanzado, considerarlo retirado en P0, Prog0
                return (targetRaceTimeSec > 1) ? { // Evitar retiro instantáneo en t=0
                    currentPosition: numDrivers + 1, // Fuera del gráfico
                    indiceProgresoAcumuladoInterpolado: 0,
                    currentLapNumber: 0,
                    isRetired: true,
                    realTimeAtEvent: targetRaceTimeSec
                } : null;
            }

            let lastCompletedLapIdx = -1;
            for (let i = 0; i < this.laps.length; i++) {
                if (this.laps[i].cumulativeRealTimeSeconds <= targetRaceTimeSec) {
                    lastCompletedLapIdx = i;
                } else {
                    break;
                }
            }
            
            // Caso: Inicio de carrera (targetRaceTimeSec = 0 o antes de completar la primera vuelta)
            if (lastCompletedLapIdx === -1) {
                const firstLap = this.laps[0];
                // Si el tiempo es 0, todos empiezan en índice de progreso 0
                if (targetRaceTimeSec === 0) {
                     return {
                        currentPosition: firstLap.position, // Posición de la primera vuelta (o de salida)
                        indiceProgresoAcumuladoInterpolado: 0,
                        currentLapNumber: 1,
                        isRetired: false,
                        realTimeAtEvent: 0
                    };
                }
                // Si está en la primera vuelta
                if (targetRaceTimeSec > 0 && firstLap.individualLapTimeSeconds > 0) {
                    if (targetRaceTimeSec > firstLap.cumulativeRealTimeSeconds && this.laps.length === 1) { // Se retiró en vuelta 1
                        return {
                            currentPosition: firstLap.position,
                            indiceProgresoAcumuladoInterpolado: firstLap.indiceProgresoAcumulado,
                            currentLapNumber: firstLap.lapNumber,
                            isRetired: true,
                            realTimeAtEvent: firstLap.cumulativeRealTimeSeconds
                        };
                    }
                    const fractionOfFirstLap = Math.min(1, Math.max(0, targetRaceTimeSec / firstLap.individualLapTimeSeconds));
                    return {
                        currentPosition: firstLap.position,
                        indiceProgresoAcumuladoInterpolado: fractionOfFirstLap * firstLap.indiceProgresoVuelta,
                        currentLapNumber: 1,
                        isRetired: false,
                        realTimeAtEvent: targetRaceTimeSec
                    };
                }
                return null; // No se puede determinar estado
            }

            const prevLapData = this.laps[lastCompletedLapIdx];
            let currentPosition = prevLapData.position;
            let indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado;
            let currentLapNumForDisplay = prevLapData.lapNumber;
            let retiredStatus = false;
            let eventTime = prevLapData.cumulativeRealTimeSeconds;

            if (targetRaceTimeSec > prevLapData.cumulativeRealTimeSeconds) {
                if ((lastCompletedLapIdx + 1) < this.laps.length) { // Hay una siguiente vuelta
                    const currentLapData = this.laps[lastCompletedLapIdx + 1];
                    currentLapNumForDisplay = currentLapData.lapNumber;
                    eventTime = targetRaceTimeSec;
                    if (currentLapData.individualLapTimeSeconds > 0) {
                        const timeIntoCurrentLap = targetRaceTimeSec - prevLapData.cumulativeRealTimeSeconds;
                        const fractionOfCurrentLap = Math.min(1, Math.max(0, timeIntoCurrentLap / currentLapData.individualLapTimeSeconds));
                        indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado + (fractionOfCurrentLap * currentLapData.indiceProgresoVuelta);
                    } else {
                        indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado; // Mantener el anterior si el tiempo de vuelta es inválido
                    }
                } else { // No hay más vueltas -> Retirado
                    retiredStatus = true;
                    indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado; // Último progreso conocido
                    currentPosition = prevLapData.position; // Última posición conocida
                    currentLapNumForDisplay = prevLapData.lapNumber;
                    eventTime = prevLapData.cumulativeRealTimeSeconds; // Momento del "retiro" (último dato)
                }
            }
            
            return {
                currentPosition: currentPosition,
                indiceProgresoAcumuladoInterpolado: indiceProgAcumInterpolated,
                currentLapNumber: currentLapNumForDisplay,
                isRetired: retiredStatus,
                realTimeAtEvent: eventTime
            };
        };
    });

    updateChart(currentRaceTimeSeconds);
    setupEventHandlers();
}

function setupEventHandlers() { /* ... igual ... */ playPauseButton.addEventListener('click', togglePlayPause); timeSlider.addEventListener('input', (event) => { if (isPlaying) pauseAnimation(); currentRaceTimeSeconds = parseFloat(event.target.value); updateChart(currentRaceTimeSeconds); }); speedSlider.addEventListener('input', (event) => { playbackSpeedFactor = parseInt(event.target.value); }); window.addEventListener('resize', () => { SVG_WIDTH = Math.max(800, window.innerWidth * 0.8 - SVG_MARGIN.left - SVG_MARGIN.right); svg.attr("width", SVG_WIDTH + SVG_MARGIN.left + SVG_MARGIN.right); svg.select("#clip rect").attr("width", SVG_WIDTH); xScale.range([0, SVG_WIDTH]); gridLinesGroup.selectAll(".grid-line").attr("x2", SVG_WIDTH); if (!isPlaying) updateChart(currentRaceTimeSeconds); }); }
function gameLoop(timestamp) { /* ... igual ... */ if (!isPlaying) return; const deltaTime = (timestamp - (lastTimestamp || timestamp)) / 1000; lastTimestamp = timestamp; currentRaceTimeSeconds += deltaTime * playbackSpeedFactor; if (currentRaceTimeSeconds >= raceData.totalRaceTimeSeconds) { currentRaceTimeSeconds = raceData.totalRaceTimeSeconds; updateChart(currentRaceTimeSeconds); pauseAnimation(); return; } updateChart(currentRaceTimeSeconds); animationFrameId = requestAnimationFrame(gameLoop); }
function playAnimation() { /* ... igual ... */ if (isPlaying) return; isPlaying = true; playPauseButton.textContent = 'Pause'; lastTimestamp = performance.now(); animationFrameId = requestAnimationFrame(gameLoop); }
function pauseAnimation() { /* ... igual ... */ if (!isPlaying && animationFrameId === null) return; isPlaying = false; cancelAnimationFrame(animationFrameId); animationFrameId = null; playPauseButton.textContent = 'Play'; }
function togglePlayPause() { /* ... igual ... */ if (isPlaying) { pauseAnimation(); } else { if (currentRaceTimeSeconds >= raceData.totalRaceTimeSeconds) { currentRaceTimeSeconds = 0; } playAnimation(); } }


function updateChart(targetRaceTimeSec) {
    if (!raceData) return;

    timeSlider.value = targetRaceTimeSec;
    currentTimeDisplay.textContent = formatTime(targetRaceTimeSec);

    let leaderSnapshot = null;
    let maxLeaderProg = -Infinity;
    raceData.driversData.forEach(driver => {
        const snapshot = driver.getSnapshot(targetRaceTimeSec);
        if (snapshot && snapshot.indiceProgresoAcumuladoInterpolado > maxLeaderProg && !snapshot.isRetired) { // El líder no puede ser un retirado
            maxLeaderProg = snapshot.indiceProgresoAcumuladoInterpolado;
            leaderSnapshot = snapshot;
        }
    });
    if (!leaderSnapshot && raceData.driversData.length > 0) { // Fallback si todos están retirados o al inicio
        const firstActiveDriverSnapshot = raceData.driversData.map(d => d.getSnapshot(targetRaceTimeSec)).find(s => s && !s.isRetired);
        leaderSnapshot = firstActiveDriverSnapshot || raceData.driversData[0].getSnapshot(targetRaceTimeSec); // O el primer piloto como último recurso
        maxLeaderProg = leaderSnapshot ? leaderSnapshot.indiceProgresoAcumuladoInterpolado : 0;
    }
    
    const leaderProgFocus = leaderSnapshot ? leaderSnapshot.indiceProgresoAcumuladoInterpolado : (targetRaceTimeSec === 0 ? 0 : IDX_PROG_FOCUS_OFFSET); // Asegurar que al inicio esté en 0
    const windowStartIndexProg = Math.max(0, leaderProgFocus - IDX_PROG_FOCUS_OFFSET);
    const maxKnownIdxProg = Math.max(...Object.values(raceData.marcasDeVueltaIndiceProg).map(Number), IDX_PROG_WINDOW_SIZE);
    const windowEndIndexProg = windowStartIndexProg + IDX_PROG_WINDOW_SIZE;

    xScale.domain([windowStartIndexProg, windowEndIndexProg]);

    const xAxisGenerator = d3.axisBottom(xScale);
    const visibleLapMarksForAxis = Object.entries(raceData.marcasDeVueltaIndiceProg)
        .map(([lapNumStr, idxProg]) => ({ lapNumber: parseInt(lapNumStr), indiceProgresoMarca: idxProg }))
        .filter(d => d.indiceProgresoMarca >= xScale.domain()[0] -1 && d.indiceProgresoMarca <= xScale.domain()[1] +1); // Pequeño buffer para ticks
      
    if (visibleLapMarksForAxis.length > 0 && (xScale.domain()[1] - xScale.domain()[0]) > 30 ) {
        xAxisGenerator.tickValues(visibleLapMarksForAxis.map(d => d.indiceProgresoMarca))
                      .tickFormat((d, i) => `${visibleLapMarksForAxis.find(m => Math.abs(m.indiceProgresoMarca - d) < 0.1)?.lapNumber || ''}`);
    } else {
        const numTicks = Math.max(2, Math.floor(SVG_WIDTH / 100));
        xAxisGenerator.ticks(numTicks).tickFormat(val => val.toFixed(0));
    }
    const xAxisTransition = isPlaying ? xAxisGroup.transition().duration(40) : xAxisGroup; // Duración de transición más corta
    xAxisTransition.call(xAxisGenerator);

    // --- MARCAS DE VUELTA ---
    const lapMarkersData = Object.entries(raceData.marcasDeVueltaIndiceProg)
        .map(([lapNum, idxProg]) => ({ lapNumber: parseInt(lapNum), indiceProgresoMarca: idxProg }))
        .filter(d => d.indiceProgresoMarca >= windowStartIndexProg && d.indiceProgresoMarca <= windowEndIndexProg);
    const lapMarkers = lapMarkerLinesGroup.selectAll(".lap-marker-line").data(lapMarkersData, d => d.lapNumber);
    lapMarkers.exit().remove();
    lapMarkers.enter().append("line").attr("class", "lap-marker-line").merge(lapMarkers).style("stroke", "#bbbbbb").style("stroke-dasharray", "4,4").style("stroke-width", "1px").attr("x1", d => xScale(d.indiceProgresoMarca)).attr("x2", d => xScale(d.indiceProgresoMarca)).attr("y1", 0).attr("y2", SVG_HEIGHT);
    const lapMarkerLabels = lapMarkerLinesGroup.selectAll(".lap-marker-label").data(lapMarkersData, d => d.lapNumber);
    lapMarkerLabels.exit().remove();
    lapMarkerLabels.enter().append("text").attr("class", "lap-marker-label").attr("text-anchor", "middle").attr("dy", "-5px").merge(lapMarkerLabels).attr("x", d => xScale(d.indiceProgresoMarca)).attr("y", SVG_MARGIN.top - 25).text(d => `L${d.lapNumber}`).style("font-size", "10px").style("fill", "#777");

    // --- LÍNEAS DE PILOTOS ---
    const lineGenerator = d3.line().x(d => d[0]).y(d => d[1]).defined(d => d[0] !== null && d[1] !== null && !isNaN(d[0]) && !isNaN(d[1]));
    const driverLines = linesGroup.selectAll(".lap-line").data(raceData.driversData, d => d.driverAbbreviation);
    driverLines.exit().remove();
    driverLines.enter().append("path").attr("class", "lap-line").style("fill", "none")
        .merge(driverLines)
        .style("stroke", d => d.teamColor || "#808080") // Aplicar color aquí
        .attr("stroke-width", 10) // Desde CSS, pero se puede forzar
        .attr("d", driver => {
            const linePoints = [];
            // Punto de inicio en X=0 si es el inicio de la carrera y el piloto está comenzando
            const initialSnapshot = driver.getSnapshot(0);
            if (targetRaceTimeSec <= (driver.laps[0]?.individualLapTimeSeconds || 10) && initialSnapshot) { // Si estamos cerca del inicio
                 const startX = xScale(0);
                 if (startX >=0 && startX <= SVG_WIDTH) { // Solo si el inicio (X=0) está visible
                    linePoints.push([startX, yScale(initialSnapshot.currentPosition)]);
                 }
            }
            
            // Puntos históricos
            driver.laps.forEach(lap => {
                const pointXVal = lap.indiceProgresoAcumulado;
                // Incluir puntos que podrían estar justo fuera de la ventana para que las líneas se extiendan al clipPath
                if (pointXVal <= windowEndIndexProg + IDX_PROG_WINDOW_SIZE * 0.2 && 
                    pointXVal >= windowStartIndexProg - IDX_PROG_WINDOW_SIZE * 0.2) {
                    linePoints.push([xScale(pointXVal), yScale(lap.position)]);
                }
            });
            linePoints.sort((a,b) => a[0] - b[0]); // Ordenar por X escalada

            // Punto actual (interpolado)
            const snapshot = driver.getSnapshot(targetRaceTimeSec);
            if (snapshot) {
                const currentXVal = snapshot.indiceProgresoAcumuladoInterpolado;
                const currentScaledX = xScale(currentXVal);
                const currentScaledY = yScale(snapshot.currentPosition);

                if (currentXVal <= windowEndIndexProg + IDX_PROG_WINDOW_SIZE * 0.1 && 
                    currentXVal >= windowStartIndexProg - IDX_PROG_WINDOW_SIZE * 0.1) {
                    
                    let addCurrentPoint = true;
                    if (linePoints.length > 0) {
                        const lastPoint = linePoints[linePoints.length - 1];
                        if (Math.abs(lastPoint[0] - currentScaledX) < 0.1 && Math.abs(lastPoint[1] - currentScaledY) < 0.1) {
                            addCurrentPoint = false; // Evitar puntos duplicados exactos
                        }
                        if (currentScaledX < lastPoint[0] && !snapshot.isRetired) { // Moviendo slider hacia atrás
                             while(linePoints.length > 0 && linePoints[linePoints.length-1][0] > currentScaledX) {
                                linePoints.pop();
                            }
                        }
                    }
                    if (addCurrentPoint && currentScaledX >= -SVG_WIDTH*0.1 && currentScaledX <= SVG_WIDTH*1.1) { // Un buffer amplio para X
                        linePoints.push([currentScaledX, currentScaledY]);
                    }
                }

                if (snapshot.isRetired) {
                    const retiroProgIdx = snapshot.indiceProgresoAcumuladoInterpolado;
                    const retiroScaledX = xScale(retiroProgIdx);
                    // Truncar puntos que estén más allá del punto de retiro
                    const finalLinePoints = linePoints.filter(p => p[0] <= retiroScaledX + 0.1); 
                    if (finalLinePoints.length > 0 && finalLinePoints[finalLinePoints.length-1][0] < retiroScaledX - 0.1 && retiroScaledX >= -10 && retiroScaledX <= SVG_WIDTH + 10) {
                        finalLinePoints.push([retiroScaledX, yScale(snapshot.currentPosition)]);
                    } else if (finalLinePoints.length === 0 && retiroScaledX >= -10 && retiroScaledX <= SVG_WIDTH + 10 ) {
                         finalLinePoints.push([retiroScaledX, yScale(snapshot.currentPosition)]);
                    }
                    return finalLinePoints.length > 1 ? lineGenerator(finalLinePoints) : null;
                }
            }
            // Eliminar puntos duplicados consecutivos antes de dibujar
            const uniquePoints = linePoints.filter((p, i, arr) => i === 0 || p[0] !== arr[i-1][0] || p[1] !== arr[i-1][1]);
            return uniquePoints.length > 1 ? lineGenerator(uniquePoints) : null;
        });

    // --- PUNTOS Y ETIQUETAS ---
    const activePilotsData = raceData.driversData.map(driver => {
        const snapshot = driver.getSnapshot(targetRaceTimeSec);
        if (snapshot && snapshot.isRetired) { // Lógica para ocultar retirados después de un tiempo
            if (targetRaceTimeSec > snapshot.realTimeAtEvent + (playbackSpeedFactor > 50 ? 5 : 15) * (IDX_PROG_WINDOW_SIZE / (raceData.metrosPistaPromedio/90) / playbackSpeedFactor * 2 ) ) { // Ocultar después de X "ventanas de tiempo"
                return null; 
            }
        }
        return snapshot ? { ...driver, snapshot } : null;
    }).filter(d => {
        if (!d || !d.snapshot) return false;
        const xPos = xScale(d.snapshot.indiceProgresoAcumuladoInterpolado);
        return xPos >= -SVG_WIDTH*0.2 && xPos <= SVG_WIDTH * 1.2; // Buffer más amplio para que no desaparezcan tan rápido
    });

    const driverDots = dotsGroup.selectAll(".driver-current-dot").data(activePilotsData, d => d.driverAbbreviation);
    driverDots.exit().remove();
    driverDots.enter().append("circle").attr("class", "driver-current-dot").attr("r", 4)
        .merge(driverDots)
        .attr("cx", d => xScale(d.snapshot.indiceProgresoAcumuladoInterpolado))
        .attr("cy", d => yScale(d.snapshot.currentPosition))
        .style("fill", d => d.teamColor || "#808080") // Aplicar color
        .style("stroke", "none") // Sin borde
        .style("opacity", d => d.snapshot.isRetired ? 0.5 : 1);

    const driverLabels = labelsGroup.selectAll(".driver-label").data(activePilotsData, d => d.driverAbbreviation);
    driverLabels.exit().remove();
    driverLabels.enter().append("text").attr("class", "driver-label").attr("dx", "8px").attr("dy", "0.35em")
        .merge(driverLabels)
        .attr("x", d => xScale(d.snapshot.indiceProgresoAcumuladoInterpolado))
        .attr("y", d => yScale(d.snapshot.currentPosition))
        .attr("fill", d => d.teamColor || "#333") // Aplicar color
        .style("opacity", d => d.snapshot.isRetired ? 0.5 : 1)
        .text(d => d.driverAbbreviation + (d.snapshot.isRetired ? " (R)" : ""));
}

document.addEventListener('DOMContentLoaded', initializeChart);