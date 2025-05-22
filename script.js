// --- Configuración del Gráfico ---
const SVG_MARGIN = { top: 40, right: 130, bottom: 60, left: 50 };
let SVG_WIDTH = 1000 - SVG_MARGIN.left - SVG_MARGIN.right;
const SVG_HEIGHT = 600 - SVG_MARGIN.top - SVG_MARGIN.bottom;

const TARGET_IDX_PROG_WINDOW_SPAN = 300; 
const LEADER_POSITION_IN_WINDOW_X = 0.80; 

// --- Variables Globales de Estado ---
let raceData = null;
let animationFrameId = null;
let lastTimestamp = 0;
let currentRaceTimeSeconds = 0; 
let playbackSpeedFactor = 30; 
let isPlaying = false;
let xScale, yScale; 
let svg, chartGroup, xAxisGroup, yAxisGroup, linesGroup, labelsGroup, /*dotsGroup,*/ gridLinesGroup, lapMarkerLinesGroup;

const raceTitleEl = document.getElementById('race-title');
const playPauseButton = document.getElementById('play-pause-button');
const timeSlider = document.getElementById('lap-slider'); 
const currentTimeDisplay = document.getElementById('current-lap-display'); 
const totalTimeDisplay = document.getElementById('total-laps-display'); 
const speedSlider = document.getElementById('speed-slider');

function formatTime(totalSeconds) { const minutes = Math.floor(totalSeconds / 60); const seconds = Math.floor(totalSeconds % 60); return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`; }

async function initializeChart() {
    try {
        const response = await fetch('race_data.json');
        if (!response.ok) { const errorText = await response.text(); console.error(`Error fetch: ${response.status} ${response.statusText}`, errorText); throw new Error(`HTTP error! status: ${response.status}`);}
        raceData = await response.json();
    } catch (error) { console.error("FALLO CRÍTICO load/parse race_data.json:", error); if (raceTitleEl) { raceTitleEl.textContent = "Error: No se pudieron cargar datos."; raceTitleEl.style.color = "red"; } if(playPauseButton) playPauseButton.disabled = true; if(timeSlider) timeSlider.disabled = true; if(speedSlider) speedSlider.disabled = true; return; }
    if (!raceData) { console.error("raceData null post try/catch."); if (raceTitleEl) raceTitleEl.textContent = "Error inesperado init."; return; }

    try {
        raceTitleEl.textContent = `${raceData.eventName} ${raceData.eventYear}`;
        totalTimeDisplay.textContent = formatTime(raceData.totalRaceTimeSeconds);
        timeSlider.max = raceData.totalRaceTimeSeconds; timeSlider.value = 0;
        currentTimeDisplay.textContent = formatTime(0);
        speedSlider.min = 1; speedSlider.max = 150; speedSlider.value = playbackSpeedFactor;
        SVG_WIDTH = Math.max(800, window.innerWidth * 0.8 - SVG_MARGIN.left - SVG_MARGIN.right);

        svg = d3.select("#race-chart").attr("width", SVG_WIDTH + SVG_MARGIN.left + SVG_MARGIN.right).attr("height", SVG_HEIGHT + SVG_MARGIN.top + SVG_MARGIN.bottom);
        svg.append("defs").append("clipPath").attr("id", "clip").append("rect").attr("width", SVG_WIDTH).attr("height", SVG_HEIGHT);
        chartGroup = svg.append("g").attr("transform", `translate(${SVG_MARGIN.left},${SVG_MARGIN.top})`);

        gridLinesGroup = chartGroup.append("g").attr("class", "grid-lines-group");
        lapMarkerLinesGroup = chartGroup.append("g").attr("class", "lap-marker-lines-group").attr("clip-path", "url(#clip)");
        linesGroup = chartGroup.append("g").attr("class", "lines-group").attr("clip-path", "url(#clip)");
        // dotsGroup = chartGroup.append("g").attr("class", "dots-group").attr("clip-path", "url(#clip)"); // Eliminado
        labelsGroup = chartGroup.append("g").attr("class", "labels-group");
        xAxisGroup = chartGroup.append("g").attr("class", "x-axis axis").attr("transform", `translate(0,${SVG_HEIGHT})`);
        yAxisGroup = chartGroup.append("g").attr("class", "y-axis axis");

        xScale = d3.scaleLinear().range([0, SVG_WIDTH]);
        let maxPositionSeen = 0;
        raceData.driversData.forEach(driver => { driver.laps.forEach(lap => { if (lap.position > maxPositionSeen) maxPositionSeen = lap.position; }); });
        const numYPositions = Math.max(20, raceData.driversData.length, maxPositionSeen);
        yScale = d3.scaleLinear().domain([0.5, numYPositions + 0.5]).range([0, SVG_HEIGHT]);

        yAxisGroup.call(d3.axisLeft(yScale).ticks(numYPositions).tickFormat(d3.format("d")));
        chartGroup.append("text").attr("class", "axis-label").attr("transform", "rotate(-90)").attr("y", 0 - SVG_MARGIN.left).attr("x", 0 - (SVG_HEIGHT / 2)).attr("dy", "0.71em").style("text-anchor", "middle").text("Position");
        chartGroup.append("text").attr("class", "axis-label").attr("x", SVG_WIDTH / 2).attr("y", SVG_HEIGHT + SVG_MARGIN.bottom - 15).style("text-anchor", "middle").text("Lap");
        gridLinesGroup.selectAll(".grid-line").data(d3.range(1, numYPositions + 1)).enter().append("line").attr("class", "grid-line").attr("x1", 0).attr("x2", SVG_WIDTH).attr("y1", d => yScale(d)).attr("y2", d => yScale(d));
        
        raceData.driversData.forEach(driver => {
            driver.getSnapshot = function(targetRaceTimeSec) {
                const numYPositionsSnapshot = Math.max(20, raceData.driversData.length, maxPositionSeen); // Para usar dentro del snapshot
                if (!this.laps || this.laps.length === 0) {
                    return (targetRaceTimeSec > 1) ? { 
                        currentPosition: numYPositionsSnapshot + 1, 
                        indiceProgresoAcumuladoInterpolado: 0,
                        currentLapNumber: 0, 
                        isRetired: true, 
                        realTimeAtEvent: targetRaceTimeSec,
                        positionBeforeRetirement: numYPositionsSnapshot + 1 
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
                
                let positionBeforeRetirement = this.laps[0]?.position; 

                if (lastCompletedLapIdx === -1) { // Aún no completa la vuelta 1, o está en ella
                    const firstLap = this.laps[0];
                    positionBeforeRetirement = firstLap.position; // Posición de la primera vuelta (o de salida)
                    if (targetRaceTimeSec === 0) { // Exactamente al inicio
                         return {
                            currentPosition: firstLap.position, 
                            indiceProgresoAcumuladoInterpolado: 0,
                            currentLapNumber: 1, 
                            isRetired: false, 
                            realTimeAtEvent: 0,
                            positionBeforeRetirement: firstLap.position
                        };
                    }
                    // Si está en la primera vuelta (targetRaceTime > 0)
                    if (targetRaceTimeSec > 0 && firstLap.individualLapTimeSeconds > 0) {
                        // Si el tiempo excede su primera vuelta y solo tiene datos de esa vuelta, se retiró.
                        if (targetRaceTimeSec > firstLap.cumulativeRealTimeSeconds && this.laps.length === 1) {
                            return {
                                currentPosition: firstLap.position, // Esta será la posición final asignada por Python si es de relleno
                                indiceProgresoAcumuladoInterpolado: firstLap.indiceProgresoAcumulado,
                                currentLapNumber: firstLap.lapNumber, 
                                isRetired: true,
                                realTimeAtEvent: firstLap.cumulativeRealTimeSeconds,
                                positionBeforeRetirement: firstLap.position // Su posición en pista antes de retirarse
                            };
                        }
                        const fractionOfFirstLap = Math.min(1, Math.max(0, targetRaceTimeSec / firstLap.individualLapTimeSeconds));
                        return {
                            currentPosition: firstLap.position, // Sigue en su posición de la vuelta 1
                            indiceProgresoAcumuladoInterpolado: fractionOfFirstLap * firstLap.indiceProgresoVuelta,
                            currentLapNumber: 1, 
                            isRetired: false, 
                            realTimeAtEvent: targetRaceTimeSec,
                            positionBeforeRetirement: firstLap.position
                        };
                    }
                    return null; // No se puede determinar estado si individualLapTimeSeconds es 0 o negativo
                }

                // Si ya ha completado al menos una vuelta
                const prevLapData = this.laps[lastCompletedLapIdx];
                positionBeforeRetirement = prevLapData.position; // Posición antes de un posible retiro en la vuelta actual
                
                let currentPosition = prevLapData.position; // Posición en pista actual (de la última vuelta completada)
                let indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado;
                let currentLapNumForDisplay = prevLapData.lapNumber;
                let retiredStatus = false;
                let eventTime = prevLapData.cumulativeRealTimeSeconds;

                // ¿Está en la siguiente vuelta o se retiró?
                if (targetRaceTimeSec > prevLapData.cumulativeRealTimeSeconds) { 
                    if ((lastCompletedLapIdx + 1) < this.laps.length) { // Hay datos para una siguiente vuelta
                        const lapDefinitionOfCurrentSegment = this.laps[lastCompletedLapIdx + 1]; 
                        // Si la siguiente vuelta en los datos NO es de relleno (isRetiredFill: false)
                        if (!lapDefinitionOfCurrentSegment.isRetiredFill) {
                            currentLapNumForDisplay = lapDefinitionOfCurrentSegment.lapNumber;
                            eventTime = targetRaceTimeSec; // El evento es el tiempo actual
                            if (lapDefinitionOfCurrentSegment.individualLapTimeSeconds > 0) {
                                const timeIntoCurrentLap = targetRaceTimeSec - prevLapData.cumulativeRealTimeSeconds;
                                const fractionOfCurrentLap = Math.min(1, Math.max(0, timeIntoCurrentLap / lapDefinitionOfCurrentSegment.individualLapTimeSeconds));
                                indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado + (fractionOfCurrentLap * lapDefinitionOfCurrentSegment.indiceProgresoVuelta);
                            } else { // Tiempo de vuelta inválido, mantener progreso anterior
                                indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado;
                            }
                        } else { // La siguiente vuelta es de relleno, así que se retiró al final de prevLapData
                            retiredStatus = true;
                            indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado; // Último progreso real
                            currentPosition = lapDefinitionOfCurrentSegment.position; // Posición final asignada de retirado
                            currentLapNumForDisplay = prevLapData.lapNumber; // Su última vuelta real activa
                            eventTime = prevLapData.cumulativeRealTimeSeconds; // Momento del "retiro" efectivo
                        }
                    } else { // No hay más vueltas registradas en `driver.laps` -> Se retiró al final de prevLapData
                        retiredStatus = true;
                        indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado;
                        // La currentPosition para el punto/etiqueta será la de la última vuelta de relleno (manejado por Python)
                        // Necesitamos encontrar la posición de la última entrada en this.laps (que será una de relleno)
                        if (this.laps[this.laps.length-1].isRetiredFill) {
                            currentPosition = this.laps[this.laps.length-1].position;
                        } else { // No debería pasar si la lógica de Python es correcta
                            currentPosition = prevLapData.position;
                        }
                        currentLapNumForDisplay = prevLapData.lapNumber;
                        eventTime = prevLapData.cumulativeRealTimeSeconds;
                    }
                }
                // Si está retirado, la currentPosition (para el punto/etiqueta) ya es la final.
                // positionBeforeRetirement es la que tenía en pista.
                
                return {
                    currentPosition: currentPosition, 
                    indiceProgresoAcumuladoInterpolado: indiceProgAcumInterpolated,
                    currentLapNumber: currentLapNumForDisplay, 
                    isRetired: retiredStatus, 
                    realTimeAtEvent: eventTime,
                    positionBeforeRetirement: positionBeforeRetirement 
                };
            };
        });

    } catch (e) { console.error("Error en init post load:", e); if (raceTitleEl) raceTitleEl.textContent = "Error procesando datos."; return; }    
    updateChart(currentRaceTimeSeconds); 
    setupEventHandlers();
}

function setupEventHandlers() { playPauseButton.addEventListener('click', togglePlayPause); timeSlider.addEventListener('input', (event) => { if (isPlaying) pauseAnimation(); currentRaceTimeSeconds = parseFloat(event.target.value); updateChart(currentRaceTimeSeconds); }); speedSlider.addEventListener('input', (event) => { playbackSpeedFactor = parseInt(event.target.value); }); window.addEventListener('resize', () => { SVG_WIDTH = Math.max(800, window.innerWidth * 0.8 - SVG_MARGIN.left - SVG_MARGIN.right); svg.attr("width", SVG_WIDTH + SVG_MARGIN.left + SVG_MARGIN.right); svg.select("#clip rect").attr("width", SVG_WIDTH); xScale.range([0, SVG_WIDTH]); gridLinesGroup.selectAll(".grid-line").attr("x2", SVG_WIDTH); if (!isPlaying) updateChart(currentRaceTimeSeconds); }); }
function gameLoop(timestamp) {
    if (!isPlaying) return;
    const deltaTime = (timestamp - (lastTimestamp || timestamp)) / 1000;
    lastTimestamp = timestamp;
    currentRaceTimeSeconds += deltaTime * playbackSpeedFactor;

    if (currentRaceTimeSeconds >= raceData.totalRaceTimeSeconds) {
        currentRaceTimeSeconds = raceData.totalRaceTimeSeconds;
        updateChart(currentRaceTimeSeconds);
        pauseAnimation();
        if(timeSlider) timeSlider.value = currentRaceTimeSeconds;
        return; 
    }
    updateChart(currentRaceTimeSeconds);
    animationFrameId = requestAnimationFrame(gameLoop);
}
function playAnimation() { if (isPlaying) return; isPlaying = true; playPauseButton.textContent = 'Pause'; lastTimestamp = performance.now(); animationFrameId = requestAnimationFrame(gameLoop); }
function pauseAnimation() { if (!isPlaying && animationFrameId === null) return; isPlaying = false; cancelAnimationFrame(animationFrameId); animationFrameId = null; playPauseButton.textContent = 'Play'; }
function togglePlayPause() { if (isPlaying) { pauseAnimation(); } else { if (currentRaceTimeSeconds >= raceData.totalRaceTimeSeconds && raceData.totalRaceTimeSeconds > 0) { currentRaceTimeSeconds = 0; } playAnimation(); } } 

function updateChart(targetRaceTimeSec) {
    if (!raceData) return;
    timeSlider.value = targetRaceTimeSec;
    currentTimeDisplay.textContent = formatTime(targetRaceTimeSec);

    let leaderProgForFocus = 0; let foundActiveLeader = false;
    const pilotSnapshots = raceData.driversData.map(driver => { const snapshot = driver.getSnapshot(targetRaceTimeSec); return snapshot ? { ...driver, snapshot } : null; }).filter(d => d && d.snapshot);
    pilotSnapshots.forEach(d => { if (!d.snapshot.isRetired && d.snapshot.indiceProgresoAcumuladoInterpolado > leaderProgForFocus) { leaderProgForFocus = d.snapshot.indiceProgresoAcumuladoInterpolado; foundActiveLeader = true; } });
    if (!foundActiveLeader && pilotSnapshots.length > 0) { let maxProgOverall = -Infinity; pilotSnapshots.forEach(d => { if (d.snapshot.indiceProgresoAcumuladoInterpolado > maxProgOverall) maxProgOverall = d.snapshot.indiceProgresoAcumuladoInterpolado; }); leaderProgForFocus = maxProgOverall !== -Infinity ? maxProgOverall : 0; }
    
    const windowEndIndexProg = leaderProgForFocus + (TARGET_IDX_PROG_WINDOW_SPAN * (1 - LEADER_POSITION_IN_WINDOW_X));
    const windowStartIndexProg = Math.max(0, windowEndIndexProg - TARGET_IDX_PROG_WINDOW_SPAN);
    xScale.domain([windowStartIndexProg, windowEndIndexProg]);
    const currentWindowSpanForBuffers = windowEndIndexProg - windowStartIndexProg;

    const xAxisGenerator = d3.axisBottom(xScale);
    const visibleLapMarksForAxis = Object.entries(raceData.marcasDeVueltaIndiceProg).map(([lapNumStr, idxProg]) => ({ lapNumber: parseInt(lapNumStr), indiceProgresoMarca: idxProg })).filter(d => d.indiceProgresoMarca >= xScale.domain()[0] -1 && d.indiceProgresoMarca <= xScale.domain()[1] +1); 
    if (visibleLapMarksForAxis.length > 0 && currentWindowSpanForBuffers > 30 ) { xAxisGenerator.tickValues(visibleLapMarksForAxis.map(d => d.indiceProgresoMarca)).tickFormat((d, i) => `${visibleLapMarksForAxis.find(m => Math.abs(m.indiceProgresoMarca - d) < 0.01)?.lapNumber || ''}`); // Aumentada tolerancia para encontrar marca
    } else { const numTicks = Math.max(2, Math.floor(SVG_WIDTH / 100)); xAxisGenerator.ticks(numTicks).tickFormat(val => val.toFixed(0)); }
    const xAxisTransition = isPlaying ? xAxisGroup.transition().duration(40) : xAxisGroup; xAxisTransition.call(xAxisGenerator);

    const lapMarkersData = Object.entries(raceData.marcasDeVueltaIndiceProg).map(([lapNum, idxProg]) => ({ lapNumber: parseInt(lapNum), indiceProgresoMarca: idxProg })).filter(d => d.indiceProgresoMarca >= windowStartIndexProg && d.indiceProgresoMarca <= windowEndIndexProg);
    const lapMarkers = lapMarkerLinesGroup.selectAll(".lap-marker-line").data(lapMarkersData, d => d.lapNumber);
    lapMarkers.exit().remove(); lapMarkers.enter().append("line").attr("class", "lap-marker-line").merge(lapMarkers).style("stroke", "#bbbbbb").style("stroke-dasharray", "4,4").style("stroke-width", "1px").attr("x1", d => xScale(d.indiceProgresoMarca)).attr("x2", d => xScale(d.indiceProgresoMarca)).attr("y1", 0).attr("y2", SVG_HEIGHT);
    const lapMarkerLabels = lapMarkerLinesGroup.selectAll(".lap-marker-label").data(lapMarkersData, d => d.lapNumber);
    lapMarkerLabels.exit().remove(); lapMarkerLabels.enter().append("text").attr("class", "lap-marker-label").attr("text-anchor", "middle").attr("dy", "-5px").merge(lapMarkerLabels).attr("x", d => xScale(d.indiceProgresoMarca)).attr("y", SVG_MARGIN.top - 25).text(d => `L${d.lapNumber}`).style("font-size", "10px").style("fill", "#777");

    const lineGenerator = d3.line().x(d => d[0]).y(d => d[1]).defined(d => d[0] !== null && d[1] !== null && !isNaN(d[0]) && !isNaN(d[1]));
    const driverLines = linesGroup.selectAll(".lap-line").data(raceData.driversData, d => d.driverAbbreviation); 
    driverLines.exit().remove();
    driverLines.enter().append("path").attr("class", "lap-line").style("fill", "none")
        .merge(driverLines)
        .style("stroke", d => d.teamColor || "#808080") .attr("stroke-width", 10) 
        .attr("d", driver => {
            const linePoints = []; const initialSnapshotForLine = driver.getSnapshot(0); 
            if (initialSnapshotForLine && targetRaceTimeSec <= (driver.laps[0]?.individualLapTimeSeconds || 5) ) { // Reducido umbral para punto inicial
                 const startX = xScale(0); if (startX >= -SVG_WIDTH*0.1 && startX <= SVG_WIDTH*1.1) { linePoints.push([startX, yScale(initialSnapshotForLine.currentPosition)]); }}
            driver.laps.forEach(lap => { if (!lap.isRetiredFill) { const pointXVal = lap.indiceProgresoAcumulado; if (pointXVal <= windowEndIndexProg + currentWindowSpanForBuffers * 0.3 && pointXVal >= windowStartIndexProg - currentWindowSpanForBuffers * 0.3) { linePoints.push([xScale(pointXVal), yScale(lap.position)]); } } }); // Buffer más grande
            linePoints.sort((a,b) => a[0] - b[0]);
            const currentSnapshot = driver.getSnapshot(targetRaceTimeSec); 
            if (currentSnapshot) {
                const currentXVal = currentSnapshot.indiceProgresoAcumuladoInterpolado; const positionForLineEnd = currentSnapshot.isRetired ? currentSnapshot.positionBeforeRetirement : currentSnapshot.currentPosition;
                const currentScaledX = xScale(currentXVal); const currentScaledY = yScale(positionForLineEnd);
                if (currentXVal <= windowEndIndexProg + currentWindowSpanForBuffers * 0.15 && currentXVal >= windowStartIndexProg - currentWindowSpanForBuffers * 0.15) { // Buffer para punto actual
                    let addCP = true; if (linePoints.length > 0) { const lP = linePoints[linePoints.length - 1]; if (Math.abs(lP[0] - currentScaledX) < 0.1 && Math.abs(lP[1] - currentScaledY) < 0.1) { addCP = false; } if (currentScaledX < lP[0] && !currentSnapshot.isRetired) { while(linePoints.length > 0 && linePoints[linePoints.length-1][0] > currentScaledX + 0.1) { linePoints.pop(); }}} // +0.1 para evitar quitar el mismo punto
                    if (addCP && currentScaledX >= -SVG_WIDTH*0.2 && currentScaledX <= SVG_WIDTH*1.2) { linePoints.push([currentScaledX, currentScaledY]); }}
                if (currentSnapshot.isRetired) { 
                    const rProgIdx = currentSnapshot.indiceProgresoAcumuladoInterpolado; const rScalX = xScale(rProgIdx);
                    let fLPoints = linePoints.filter(p => p[0] <= rScalX + 0.1); 
                    if (fLPoints.length > 0) { if (fLPoints[fLPoints.length-1][0] < rScalX - 0.1 && rScalX >= -10 && rScalX <= SVG_WIDTH + 10) { fLPoints.push([rScalX, yScale(currentSnapshot.positionBeforeRetirement)]); } else if (fLPoints[fLPoints.length-1][0] > rScalX + 0.1) { fLPoints.pop(); if (rScalX >= -10 && rScalX <= SVG_WIDTH + 10) { fLPoints.push([rScalX, yScale(currentSnapshot.positionBeforeRetirement)]);}}}
                    else if (rScalX >= -10 && rScalX <= SVG_WIDTH + 10 ) { fLPoints.push([rScalX, yScale(currentSnapshot.positionBeforeRetirement)]); }
                    // Asegurar que la línea no se extienda más allá del punto de retiro si el último punto calculado está más allá
                    if (fLPoints.length > 0 && fLPoints[fLPoints.length-1][0] > rScalX + 0.1) {
                        fLPoints = fLPoints.filter(p => p[0] <= rScalX + 0.1);
                        // Si después de filtrar el último punto no es el de retiro, añadirlo
                        if (fLPoints.length === 0 || (fLPoints.length > 0 && Math.abs(fLPoints[fLPoints.length-1][0] - rScalX) > 0.1) ) {
                             if (rScalX >= -10 && rScalX <= SVG_WIDTH + 10) fLPoints.push([rScalX, yScale(currentSnapshot.positionBeforeRetirement)]);
                        }
                    }
                    return fLPoints.length > 1 ? lineGenerator(fLPoints) : null; }}
            const uPoints = linePoints.filter((p, i, arr) => i === 0 || Math.abs(p[0] - arr[i-1][0]) > 0.01 || Math.abs(p[1] - arr[i-1][1]) > 0.01); // Tolerancia para puntos únicos
            return uPoints.length > 1 ? lineGenerator(uPoints) : null;
        });

    const pilotSnapshotsForDisplay = pilotSnapshots.filter(d => { 
        if (!d ) return false; const xPos = xScale(d.snapshot.indiceProgresoAcumuladoInterpolado);
        if (d.snapshot.isRetired && targetRaceTimeSec > d.snapshot.realTimeAtEvent + 45) { return false; } // Aumentar tiempo de visibilidad de retirados
        return xPos >= -SVG_WIDTH*0.1 && xPos <= SVG_WIDTH * 1.1; // Buffer más amplio para etiquetas
    });

    // SECCIÓN DE PUNTOS COMENTADA/ELIMINADA
    /* const driverDots ... */

    const driverLabels = labelsGroup.selectAll(".driver-label").data(pilotSnapshotsForDisplay, d => d.driverAbbreviation); 
    driverLabels.exit().remove();
    driverLabels.enter().append("text").attr("class", "driver-label").attr("dx", "3px").attr("dy", "0.35em")
        .merge(driverLabels)
        .attr("x", d => xScale(d.snapshot.indiceProgresoAcumuladoInterpolado))
        .attr("y", d => yScale(d.snapshot.currentPosition)) 
        .attr("fill", d => d.teamColor || "#C0C0C0") 
        .style("opacity", d => d.snapshot.isRetired ? 0.5 : 1) // Opacidad reducida para retirados
        .text(d => d.driverAbbreviation + (d.snapshot.isRetired ? " (R)" : ""));
}

document.addEventListener('DOMContentLoaded', initializeChart);