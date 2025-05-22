// --- Configuración del Gráfico ---
const SVG_MARGIN = { top: 40, right: 130, bottom: 60, left: 50 }; // Más margen
let SVG_WIDTH = 1000 - SVG_MARGIN.left - SVG_MARGIN.right; // Ancho base
const SVG_HEIGHT = 600 - SVG_MARGIN.top - SVG_MARGIN.bottom; // Alto base

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
    } catch (error) {
        console.error("Error cargando race_data.json:", error);
        raceTitleEl.textContent = "Error cargando datos de la carrera.";
        return;
    }

    raceTitleEl.textContent = `${raceData.eventName} ${raceData.eventYear}`;
    totalTimeDisplay.textContent = formatTime(raceData.totalRaceTimeSeconds);
    timeSlider.max = raceData.totalRaceTimeSeconds;
    timeSlider.value = 0;
    currentTimeDisplay.textContent = formatTime(0);

    speedSlider.min = 1;
    speedSlider.max = 150; // Aumentar rango de velocidad
    speedSlider.value = playbackSpeedFactor;

    SVG_WIDTH = Math.max(800, window.innerWidth * 0.8 - SVG_MARGIN.left - SVG_MARGIN.right); // Hacerlo más responsivo

    svg = d3.select("#race-chart")
        .attr("width", SVG_WIDTH + SVG_MARGIN.left + SVG_MARGIN.right)
        .attr("height", SVG_HEIGHT + SVG_MARGIN.top + SVG_MARGIN.bottom);

    svg.append("defs").append("clipPath")
        .attr("id", "clip")
      .append("rect")
        .attr("width", SVG_WIDTH)
        .attr("height", SVG_HEIGHT);

    chartGroup = svg.append("g")
        .attr("transform", `translate(${SVG_MARGIN.left},${SVG_MARGIN.top})`);

    gridLinesGroup = chartGroup.append("g").attr("class", "grid-lines-group");
    lapMarkerLinesGroup = chartGroup.append("g").attr("class", "lap-marker-lines-group").attr("clip-path", "url(#clip)");
    linesGroup = chartGroup.append("g").attr("class", "lines-group").attr("clip-path", "url(#clip)");
    dotsGroup = chartGroup.append("g").attr("class", "dots-group").attr("clip-path", "url(#clip)");
    labelsGroup = chartGroup.append("g").attr("class", "labels-group"); // No clipear etiquetas para que se vean al borde
    xAxisGroup = chartGroup.append("g").attr("class", "x-axis axis")
                           .attr("transform", `translate(0,${SVG_HEIGHT})`);
    yAxisGroup = chartGroup.append("g").attr("class", "y-axis axis");

    xScale = d3.scaleLinear().range([0, SVG_WIDTH]);
    const numDrivers = Math.max(20, raceData.driversData.length);
    yScale = d3.scaleLinear().domain([0.5, numDrivers + 0.5]).range([0, SVG_HEIGHT]);

    yAxisGroup.call(d3.axisLeft(yScale).ticks(numDrivers).tickFormat(d3.format("d")));
    chartGroup.append("text")
        .attr("class", "axis-label")
        .attr("transform", "rotate(-90)")
        .attr("y", 0 - SVG_MARGIN.left) // Ajuste de etiqueta Y
        .attr("x", 0 - (SVG_HEIGHT / 2))
        .attr("dy", "0.71em") // Mejor alineación vertical
        .style("text-anchor", "middle")
        .text("Position");
    
    chartGroup.append("text") // Etiqueta Eje X
        .attr("class", "axis-label")
        .attr("x", SVG_WIDTH / 2)
        .attr("y", SVG_HEIGHT + SVG_MARGIN.bottom - 15) // Ajuste de etiqueta X
        .style("text-anchor", "middle")
        .text("Lap");


    gridLinesGroup.selectAll(".grid-line")
        .data(d3.range(1, numDrivers + 1)).enter().append("line")
        .attr("class", "grid-line").attr("x1", 0).attr("x2", SVG_WIDTH)
        .attr("y1", d => yScale(d)).attr("y2", d => yScale(d));
    
    raceData.driversData.forEach(driver => {
        driver.getSnapshot = function(targetRaceTimeSec) {
            if (!this.laps || this.laps.length === 0) return null;
            let lastCompletedLapIdx = -1;
            for (let i = 0; i < this.laps.length; i++) {
                if (this.laps[i].cumulativeRealTimeSeconds <= targetRaceTimeSec) {
                    lastCompletedLapIdx = i;
                } else {
                    break;
                }
            }

            if (lastCompletedLapIdx === -1) {
                if (targetRaceTimeSec > 0 && this.laps.length > 0) {
                    const firstLap = this.laps[0];
                    if (firstLap.individualLapTimeSeconds > 0) {
                         // Si el tiempo de carrera es mayor que el tiempo de su primera vuelta, pero no hay más vueltas, se retiró.
                        if (targetRaceTimeSec > firstLap.cumulativeRealTimeSeconds && this.laps.length === 1) {
                            return {
                                currentPosition: firstLap.position,
                                indiceProgresoAcumuladoInterpolado: firstLap.indiceProgresoAcumulado,
                                currentLapNumber: firstLap.lapNumber,
                                isRetired: true,
                                realTimeAtEvent: firstLap.cumulativeRealTimeSeconds // Momento del retiro
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
                }
                return null;
            }

            const prevLapData = this.laps[lastCompletedLapIdx];
            let currentPosition = prevLapData.position;
            let indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado;
            let currentLapNumForDisplay = prevLapData.lapNumber;
            let retiredStatus = false;
            let eventTime = prevLapData.cumulativeRealTimeSeconds;

            if (targetRaceTimeSec > prevLapData.cumulativeRealTimeSeconds) {
                if ((lastCompletedLapIdx + 1) < this.laps.length) {
                    const currentLapData = this.laps[lastCompletedLapIdx + 1];
                    currentLapNumForDisplay = currentLapData.lapNumber;
                    eventTime = targetRaceTimeSec;
                    if (currentLapData.individualLapTimeSeconds > 0) {
                        const timeIntoCurrentLap = targetRaceTimeSec - prevLapData.cumulativeRealTimeSeconds;
                        const fractionOfCurrentLap = Math.min(1, Math.max(0, timeIntoCurrentLap / currentLapData.individualLapTimeSeconds));
                        indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado + (fractionOfCurrentLap * currentLapData.indiceProgresoVuelta);
                    } else { // Tiempo de vuelta 0 o inválido, tomar el progreso anterior
                        indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado;
                    }
                } else {
                    retiredStatus = true;
                    indiceProgAcumInterpolated = prevLapData.indiceProgresoAcumulado;
                    currentPosition = prevLapData.position;
                    currentLapNumForDisplay = prevLapData.lapNumber;
                    eventTime = prevLapData.cumulativeRealTimeSeconds; // Momento del retiro
                }
            }
            
            return {
                currentPosition: currentPosition,
                indiceProgresoAcumuladoInterpolado: indiceProgAcumInterpolated,
                currentLapNumber: currentLapNumForDisplay,
                isRetired: retiredStatus,
                realTimeAtEvent: eventTime // El tiempo real del evento (sea el target o el del retiro)
            };
        };
    });

    updateChart(currentRaceTimeSeconds);
    setupEventHandlers(); // Mover listeners a una función separada
}

function setupEventHandlers() {
    playPauseButton.addEventListener('click', togglePlayPause);
    timeSlider.addEventListener('input', (event) => {
        if (isPlaying) pauseAnimation();
        currentRaceTimeSeconds = parseFloat(event.target.value);
        updateChart(currentRaceTimeSeconds);
    });
    speedSlider.addEventListener('input', (event) => {
        playbackSpeedFactor = parseInt(event.target.value);
    });

    window.addEventListener('resize', () => {
        SVG_WIDTH = Math.max(800, window.innerWidth * 0.8 - SVG_MARGIN.left - SVG_MARGIN.right);
        svg.attr("width", SVG_WIDTH + SVG_MARGIN.left + SVG_MARGIN.right);
        svg.select("#clip rect").attr("width", SVG_WIDTH);
        xScale.range([0, SVG_WIDTH]);
        gridLinesGroup.selectAll(".grid-line").attr("x2", SVG_WIDTH);
        if (!isPlaying) updateChart(currentRaceTimeSeconds);
    });
}


function gameLoop(timestamp) { /* ... igual ... */ if (!isPlaying) return; const deltaTime = (timestamp - (lastTimestamp || timestamp)) / 1000; lastTimestamp = timestamp; currentRaceTimeSeconds += deltaTime * playbackSpeedFactor; if (currentRaceTimeSeconds >= raceData.totalRaceTimeSeconds) { currentRaceTimeSeconds = raceData.totalRaceTimeSeconds; updateChart(currentRaceTimeSeconds); pauseAnimation(); return; } updateChart(currentRaceTimeSeconds); animationFrameId = requestAnimationFrame(gameLoop); }
function playAnimation() { /* ... igual ... */ if (isPlaying) return; isPlaying = true; playPauseButton.textContent = 'Pause'; lastTimestamp = performance.now(); animationFrameId = requestAnimationFrame(gameLoop); }
function pauseAnimation() { /* ... igual ... */ if (!isPlaying && animationFrameId === null) return; isPlaying = false; cancelAnimationFrame(animationFrameId); animationFrameId = null; playPauseButton.textContent = 'Play'; }
function togglePlayPause() { /* ... igual ... */ if (isPlaying) { pauseAnimation(); } else { if (currentRaceTimeSeconds >= raceData.totalRaceTimeSeconds) { currentRaceTimeSeconds = 0; } playAnimation(); } }

function updateChart(targetRaceTimeSec) {
    if (!raceData) return;

    timeSlider.value = targetRaceTimeSec;
    currentTimeDisplay.textContent = formatTime(targetRaceTimeSec);

    let leaderSnapshot = null;
    let maxLeaderProg = -Infinity; // Iniciar con -Infinity para encontrar el máximo correctamente

    raceData.driversData.forEach(driver => {
        const snapshot = driver.getSnapshot(targetRaceTimeSec);
        if (snapshot && snapshot.indiceProgresoAcumuladoInterpolado > maxLeaderProg) {
            maxLeaderProg = snapshot.indiceProgresoAcumuladoInterpolado;
            leaderSnapshot = snapshot;
        }
    });
    
    const leaderProgFocus = leaderSnapshot ? leaderSnapshot.indiceProgresoAcumuladoInterpolado : 0;
    const windowStartIndexProg = Math.max(0, leaderProgFocus - IDX_PROG_FOCUS_OFFSET);
    // Calcular el máximo índice de progreso posible basado en las marcas de vuelta para un dominio X más ajustado
    const maxPossibleIdxProg = Math.max(...Object.values(raceData.marcasDeVueltaIndiceProg).map(Number), IDX_PROG_WINDOW_SIZE);
    const windowEndIndexProg = Math.min(maxPossibleIdxProg + IDX_PROG_WINDOW_SIZE * 0.1, windowStartIndexProg + IDX_PROG_WINDOW_SIZE); // Un poco de buffer

    xScale.domain([windowStartIndexProg, windowEndIndexProg]);

    const xAxisGenerator = d3.axisBottom(xScale);
    const visibleLapMarksForAxis = Object.entries(raceData.marcasDeVueltaIndiceProg)
        .map(([lapNumStr, idxProg]) => ({ lapNumber: parseInt(lapNumStr), indiceProgresoMarca: idxProg }))
        .filter(d => d.indiceProgresoMarca >= xScale.domain()[0] && d.indiceProgresoMarca <= xScale.domain()[1]);
      
    if (visibleLapMarksForAxis.length > 1 && (xScale.domain()[1] - xScale.domain()[0]) > 50 ) { // Mostrar Laps si hay varias y la ventana es suficientemente amplia
        xAxisGenerator.tickValues(visibleLapMarksForAxis.map(d => d.indiceProgresoMarca))
                      .tickFormat((d, i) => `${visibleLapMarksForAxis[i].lapNumber}`); // Solo el número de vuelta
    } else {
        const numTicks = Math.max(2, Math.floor(SVG_WIDTH / 80)); // Más ticks si la ventana es amplia
        xAxisGenerator.ticks(numTicks).tickFormat(val => val.toFixed(0));
    }

    const xAxisTransition = isPlaying ? xAxisGroup.transition().duration(50) : xAxisGroup;
    xAxisTransition.call(xAxisGenerator);

    // --- MARCAS DE VUELTA ---
    const lapMarkersData = Object.entries(raceData.marcasDeVueltaIndiceProg)
        .map(([lapNum, idxProg]) => ({ lapNumber: parseInt(lapNum), indiceProgresoMarca: idxProg }))
        .filter(d => d.indiceProgresoMarca >= windowStartIndexProg && d.indiceProgresoMarca <= windowEndIndexProg);

    const lapMarkers = lapMarkerLinesGroup.selectAll(".lap-marker-line")
        .data(lapMarkersData, d => d.lapNumber);
    lapMarkers.exit().remove();
    lapMarkers.enter().append("line").attr("class", "lap-marker-line")
        .merge(lapMarkers)
        .style("stroke", "#bbbbbb").style("stroke-dasharray", "4,4").style("stroke-width", "1px")
        .attr("x1", d => xScale(d.indiceProgresoMarca)).attr("x2", d => xScale(d.indiceProgresoMarca))
        .attr("y1", 0).attr("y2", SVG_HEIGHT);
    
    const lapMarkerLabels = lapMarkerLinesGroup.selectAll(".lap-marker-label")
        .data(lapMarkersData, d => d.lapNumber);
    lapMarkerLabels.exit().remove();
    lapMarkerLabels.enter().append("text").attr("class", "lap-marker-label")
        .attr("text-anchor", "middle").attr("dy", "-5px")
        .merge(lapMarkerLabels)
        .attr("x", d => xScale(d.indiceProgresoMarca)).attr("y", SVG_MARGIN.top - 25) // Posicionar etiquetas de vuelta arriba
        .text(d => `L${d.lapNumber}`)
        .style("font-size", "10px").style("fill", "#777");


    // --- LÍNEAS DE PILOTOS ---
    const lineGenerator = d3.line().x(d => d[0]).y(d => d[1]).defined(d => d[0] !== null && d[1] !== null);

    const driverLines = linesGroup.selectAll(".lap-line")
        .data(raceData.driversData, d => d.driverAbbreviation);
    driverLines.exit().remove();
    driverLines.enter().append("path").attr("class", "lap-line").style("fill", "none")
        .merge(driverLines)
        .style("stroke", d => d.teamColor || "#808080")
        .attr("stroke-width", 3.5) // Grosor desde CSS, pero se puede forzar aquí
        .attr("d", driver => {
            const linePoints = [];
            driver.laps.forEach(lap => { // Usar todos los datos históricos de vueltas completadas
                const pointXVal = lap.indiceProgresoAcumulado;
                if (pointXVal <= windowEndIndexProg + IDX_PROG_WINDOW_SIZE*0.1 && // un poco más allá de la ventana
                    pointXVal >= windowStartIndexProg - IDX_PROG_WINDOW_SIZE*0.1) { // un poco antes de la ventana
                    linePoints.push([xScale(pointXVal), yScale(lap.position)]);
                }
            });
            linePoints.sort((a,b) => a[0] - b[0]); // Ordenar por X después de escalar

            const snapshot = driver.getSnapshot(targetRaceTimeSec);
            if (snapshot) {
                const currentXVal = snapshot.indiceProgresoAcumuladoInterpolado;
                const currentScaledX = xScale(currentXVal);
                const currentScaledY = yScale(snapshot.currentPosition);

                // Solo añadir el punto actual si está dentro de la vista o justo fuera para el crecimiento
                if (currentXVal <= windowEndIndexProg + IDX_PROG_WINDOW_SIZE*0.05 && 
                    currentXVal >= windowStartIndexProg - IDX_PROG_WINDOW_SIZE*0.05) {

                    if (linePoints.length === 0) {
                        linePoints.push([currentScaledX, currentScaledY]);
                    } else {
                        const lastHistPoint = linePoints[linePoints.length - 1];
                        // Añadir si es diferente o si es el mismo X pero diferente Y
                        if (currentScaledX > lastHistPoint[0] || 
                           (Math.abs(currentScaledX - lastHistPoint[0]) < 0.1 && Math.abs(currentScaledY - lastHistPoint[1]) > 0.1)) {
                            linePoints.push([currentScaledX, currentScaledY]);
                        } else if (currentScaledX < lastHistPoint[0]) { // Moviendo slider hacia atrás
                            while(linePoints.length > 0 && linePoints[linePoints.length-1][0] > currentScaledX) {
                                linePoints.pop();
                            }
                            linePoints.push([currentScaledX, currentScaledY]);
                        } else if (Math.abs(currentScaledX - lastHistPoint[0]) < 0.1 && Math.abs(currentScaledY - lastHistPoint[1]) < 0.1 && snapshot.isRetired) {
                            // Si es retirado y el punto es el mismo, no hacer nada para evitar duplicados exactos
                        } else if (linePoints.length > 0 && Math.abs(currentScaledX - lastHistPoint[0]) < 0.1 && Math.abs(currentScaledY - lastHistPoint[1]) < 0.1) {
                            // Si es el mismo punto, no lo añadas de nuevo a menos que sea el único punto
                        } else {
                             linePoints.push([currentScaledX, currentScaledY]);
                        }
                    }
                }
                // Si está retirado, la línea no debe extenderse más allá de su punto de retiro
                if (snapshot.isRetired) {
                    const retiroX = xScale(snapshot.indiceProgresoAcumuladoInterpolado);
                    // Truncar puntos que estén más allá del punto de retiro
                    const finalLinePoints = linePoints.filter(p => p[0] <= retiroX + 0.1); // +0.1 por errores de flotantes
                    // Asegurar que el último punto sea exactamente el del retiro si está visible
                    if (finalLinePoints.length > 0 && finalLinePoints[finalLinePoints.length-1][0] < retiroX -0.1 && retiroX >=0 && retiroX <= SVG_WIDTH) {
                        finalLinePoints.push([retiroX, yScale(snapshot.currentPosition)]);
                    } else if (finalLinePoints.length === 0 && retiroX >=0 && retiroX <= SVG_WIDTH) {
                         finalLinePoints.push([retiroX, yScale(snapshot.currentPosition)]);
                    }
                    return finalLinePoints.length > 1 ? lineGenerator(finalLinePoints) : null;
                }
            }
            return linePoints.length > 1 ? lineGenerator(linePoints) : null;
        });

    // --- PUNTOS Y ETIQUETAS ---
    const activePilotsData = raceData.driversData.map(driver => {
        const snapshot = driver.getSnapshot(targetRaceTimeSec);
        return snapshot ? { ...driver, snapshot } : null;
    }).filter(d => d && d.snapshot && 
                     xScale(d.snapshot.indiceProgresoAcumuladoInterpolado) >= -20 && // Ampliar buffer para etiquetas
                     xScale(d.snapshot.indiceProgresoAcumuladoInterpolado) <= SVG_WIDTH + 20);

    const driverDots = dotsGroup.selectAll(".driver-current-dot")
        .data(activePilotsData, d => d.driverAbbreviation);
    driverDots.exit().remove();
    driverDots.enter().append("circle").attr("class", "driver-current-dot").attr("r", 4)
        .merge(driverDots)
        .attr("cx", d => xScale(d.snapshot.indiceProgresoAcumuladoInterpolado))
        .attr("cy", d => yScale(d.snapshot.currentPosition))
        .style("fill", d => d.teamColor || "#808080")
        .style("stroke", d => d.snapshot.isRetired ? (d.teamColor || "#808080") : "black") // Borde negro solo si no está retirado
        .style("stroke-width", "1.5px")
        .style("opacity", d => d.snapshot.isRetired ? 0.6 : 1);

    const driverLabels = labelsGroup.selectAll(".driver-label")
        .data(activePilotsData, d => d.driverAbbreviation);
    driverLabels.exit().remove();
    driverLabels.enter().append("text").attr("class", "driver-label").attr("dx", "8px").attr("dy", "0.35em")
        .merge(driverLabels)
        .attr("x", d => xScale(d.snapshot.indiceProgresoAcumuladoInterpolado))
        .attr("y", d => yScale(d.snapshot.currentPosition))
        .attr("fill", d => d.teamColor || "#333")
        .style("opacity", d => d.snapshot.isRetired ? 0.6 : 1)
        .text(d => d.driverAbbreviation + (d.snapshot.isRetired ? " (R)" : "")); // (R) para retirado
}

document.addEventListener('DOMContentLoaded', initializeChart);