import fastf1 as ff1
import pandas as pd
import json
import os

# --- Configuración ---
RACE_YEAR = 2023
RACE_EVENT = 'Bahrain Grand Prix' # Asegúrate de que el nombre del evento sea correcto
OUTPUT_JSON_FILE = 'race_data.json'
METROS_PISTA_PROMEDIO = 5412 # Longitud de la pista de Bahrain en metros. ¡Ajusta si usas otra carrera!
# Puedes obtener esto de session.event.get_roster().Circuit['length'] si FastF1 lo proporciona,
# o buscarlo manualmente. Usaremos un valor fijo por ahora para simplificar.
# Si no está disponible, se usará un valor por defecto.

# --- Habilitar el caché de FastF1 ---
CACHE_DIR = 'fastf1_cache'
if not os.path.exists(CACHE_DIR):
    try:
        os.makedirs(CACHE_DIR)
        print(f"Directorio de caché '{CACHE_DIR}' creado.")
    except OSError as e:
        print(f"Error al crear el directorio de caché '{CACHE_DIR}': {e}")
        exit()
try:
    ff1.Cache.enable_cache(CACHE_DIR)
except Exception as e:
    print(f"Error al habilitar el caché de FastF1: {e}")
    exit()

print(f"Cargando datos para {RACE_EVENT} {RACE_YEAR}...")
try:
    session = ff1.get_session(RACE_YEAR, RACE_EVENT, 'R')
    session.load(laps=True, telemetry=False, weather=False, messages=False) # Solo necesitamos laps y results implicitamente
    laps_data = session.laps
except Exception as e:
    print(f"Error al cargar datos de la sesión: {e}")
    print("Asegúrate de que el nombre del evento y el año son correctos.")
    print("Ejemplos: 'Bahrain Grand Prix', 'Monaco Grand Prix', 'Italian Grand Prix'")
    exit()

if laps_data is None or laps_data.empty:
    print(f"No se encontraron datos de vueltas para {RACE_EVENT} {RACE_YEAR}.")
    exit()

print("Datos cargados. Procesando...")

# Intentar obtener la longitud real de la pista si está disponible
# Esto puede variar según la versión de FastF1 o la disponibilidad de datos
actual_metros_pista = METROS_PISTA_PROMEDIO
try:
    # Para FastF1 v3.x, la información del circuito está en SessionInfo
    if hasattr(session.event, 'SessionInfo') and 'Circuit' in session.event.SessionInfo and 'Key' in session.event.SessionInfo.Circuit:
        # Este es un camino más indirecto y podría no ser siempre el más fácil
        # circuit_key = session.event.SessionInfo.Circuit.Key
        # circuit_details = ff1.get_event(RACE_YEAR, circuit_key) # Esto podría no ser una función directa
        # Si hay una forma más directa en tu versión de fastf1, úsala.
        # Por ahora, nos quedamos con el valor fijo o un fallback.
        # Una forma más robusta sería buscar el circuito en session.event.Meeting.Circuit
        # y luego obtener sus detalles.
        # Ejemplo potencial (puede necesitar ajuste según tu versión de ff1):
        # circuit_name_short = session.event.CircuitName o session.event.EventName (si es único para el circuito)
        # schedule = ff1.get_event_schedule(RACE_YEAR)
        # event_obj_for_circuit = schedule.get_event_by_name(session.event.EventName) # o por nombre de circuito
        # if event_obj_for_circuit and hasattr(event_obj_for_circuit, 'get_circuit_info'):
        #    circuit_info = event_obj_for_circuit.get_circuit_info()
        #    if circuit_info and circuit_info.length:
        #        actual_metros_pista = circuit_info.length * 1000 # si está en km
        # Como esto es complejo y variable, usaremos el valor fijo por ahora.
        print(f"Usando METROS_PISTA_PROMEDIO = {actual_metros_pista} (valor fijo o por defecto).")
    else:
        print(f"No se pudo obtener la longitud del circuito automáticamente. Usando METROS_PISTA_PROMEDIO = {actual_metros_pista}.")

except Exception as e_circuit:
    print(f"Error obteniendo longitud de pista, usando por defecto {actual_metros_pista}: {e_circuit}")


total_laps_race_from_data = int(laps_data['LapNumber'].max())
event_name = session.event['EventName']
event_year = RACE_YEAR

# Estructura para el JSON final
output_data = {
    "eventName": event_name,
    "eventYear": event_year,
    "totalRaceTimeSeconds": 0, # Se actualizará
    "totalLaps": total_laps_race_from_data,
    "metrosPistaPromedio": actual_metros_pista,
    "marcasDeVueltaIndiceProg": {}, # { "1": 10.09, "2": 19.50, ... }
    "driversData": []
}

# --- Obtener información de pilotos y colores ---
# (Misma lógica que antes para driver_info_map y driver_colors, la omito por brevedad aquí
#  pero debe estar en tu script)
driver_info_map = {}
if hasattr(session, 'results') and session.results is not None and not session.results.empty:
    for _, r_info in session.results.iterrows():
        driver_number = r_info['DriverNumber']
        abbr = r_info['Abbreviation']
        team_name = r_info['TeamName']
        color = '#808080'
        try:
            # FastF1 v3.1+ usa session_event_year y session_type
            if hasattr(session.event, 'year'): # Para FastF1 < v3.1
                 col_candidate = fastf1.plotting.get_driver_color(abbr, year=session.event.year, session_type=session.name)
            else: # Para FastF1 >= v3.1
                 col_candidate = fastf1.plotting.get_driver_color(abbr, session_event_year=session.event.SessionInfo.Meeting.FIAConfig.CurrentYear, session_type=session.name)

            if not pd.isna(col_candidate): color = col_candidate
            elif team_name:
                if hasattr(session.event, 'year'): col_candidate_team = fastf1.plotting.team_color(team_name, year=session.event.year)
                else: col_candidate_team = fastf1.plotting.team_color(team_name, session_event_year=session.event.SessionInfo.Meeting.FIAConfig.CurrentYear)
                if not pd.isna(col_candidate_team): color = col_candidate_team
        except Exception: pass
        driver_info_map[driver_number] = {"abbreviation": abbr, "teamName": team_name, "teamColor": color}

for dr_num_laps in laps_data['DriverNumber'].unique():
    if dr_num_laps not in driver_info_map:
        try:
            driver_laps_subset = laps_data[laps_data['DriverNumber'] == dr_num_laps].iloc[0]
            abbr = driver_laps_subset['Driver']
            team_name = driver_laps_subset['Team']
            color = '#808080'
            if hasattr(session.event, 'year'): col_candidate = fastf1.plotting.get_driver_color(abbr, year=session.event.year, session_type=session.name)
            else: col_candidate = fastf1.plotting.get_driver_color(abbr, session_event_year=session.event.SessionInfo.Meeting.FIAConfig.CurrentYear, session_type=session.name)

            if not pd.isna(col_candidate): color = col_candidate
            elif team_name:
                if hasattr(session.event, 'year'): col_candidate_team = fastf1.plotting.team_color(team_name, year=session.event.year)
                else: col_candidate_team = fastf1.plotting.team_color(team_name, session_event_year=session.event.SessionInfo.Meeting.FIAConfig.CurrentYear)
                if not pd.isna(col_candidate_team): color = col_candidate_team
            driver_info_map[dr_num_laps] = {"abbreviation": abbr, "teamName": team_name, "teamColor": color}
        except IndexError:
            print(f"Advertencia: No se pudo obtener información del piloto para DriverNumber {dr_num_laps} desde laps_data.")
            # Podrías asignar un placeholder si es necesario o simplemente omitirlo
            driver_info_map[dr_num_laps] = {"abbreviation": f"DRV{dr_num_laps}", "teamName": "Unknown", "teamColor": "#808080"}


# --- Recopilar datos de vuelta con Índice de Progreso ---
max_cumulative_real_time_overall = 0
all_laps_info_for_marks = [] # Para calcular marcasDeVueltaIndiceProg

for driver_number_str, info in driver_info_map.items():
    # FastF1 a veces usa strings para DriverNumber en laps, otras veces int. Intentar convertir.
    try:
        driver_number = int(driver_number_str)
    except ValueError:
        print(f"Advertencia: DriverNumber '{driver_number_str}' no es un entero válido. Saltando piloto.")
        continue
        
    driver_laps_df = laps_data[laps_data['DriverNumber'] == str(driver_number)].copy() # Usar str(driver_number) por consistencia con la clave del map

    if 'LapTime' not in driver_laps_df.columns or 'Position' not in driver_laps_df.columns:
        print(f"Advertencia: 'LapTime' o 'Position' no encontrado para {info['abbreviation']}. Saltando.")
        continue
    
    driver_laps_df.dropna(subset=['LapTime', 'Position'], inplace=True)
    if driver_laps_df.empty:
        continue

    if pd.api.types.is_timedelta64_dtype(driver_laps_df['LapTime']):
        driver_laps_df['IndividualLapTimeSeconds'] = driver_laps_df['LapTime'].dt.total_seconds()
    else:
        driver_laps_df['IndividualLapTimeSeconds'] = pd.to_numeric(driver_laps_df['LapTime'], errors='coerce')
    
    driver_laps_df.dropna(subset=['IndividualLapTimeSeconds'], inplace=True) # Quitar si la conversión falló
    if driver_laps_df.empty:
        continue

    driver_laps_df = driver_laps_df.sort_values(by='LapNumber')
    driver_laps_df['CumulativeRealTimeSeconds'] = driver_laps_df['IndividualLapTimeSeconds'].cumsum()
    
    # Calcular Índice de Progreso
    # Evitar división por cero si un tiempo de vuelta es 0 (muy improbable pero por seguridad)
    driver_laps_df['IndiceProgresoVuelta'] = driver_laps_df['IndividualLapTimeSeconds'].apply(
        lambda x: (actual_metros_pista / x) if x > 0 else 0
    )
    driver_laps_df['IndiceProgresoAcumulado'] = driver_laps_df['IndiceProgresoVuelta'].cumsum()

    lap_data_for_json = []
    for _, row in driver_laps_df.iterrows():
        lap_num = int(row['LapNumber'])
        pos = int(row['Position'])
        ind_lap_time = round(row['IndividualLapTimeSeconds'], 3)
        cum_real_time = round(row['CumulativeRealTimeSeconds'], 3)
        idx_prog_vuelta = round(row['IndiceProgresoVuelta'], 3)
        idx_prog_acum = round(row['IndiceProgresoAcumulado'], 3)

        lap_data_for_json.append({
            "lapNumber": lap_num,
            "position": pos,
            "individualLapTimeSeconds": ind_lap_time,
            "cumulativeRealTimeSeconds": cum_real_time,
            "indiceProgresoVuelta": idx_prog_vuelta,
            "indiceProgresoAcumulado": idx_prog_acum
        })
        
        all_laps_info_for_marks.append({
            "lapNumber": lap_num,
            "position": pos,
            "indiceProgresoAcumulado": idx_prog_acum
        })

        if cum_real_time > max_cumulative_real_time_overall:
            max_cumulative_real_time_overall = cum_real_time
            
    if lap_data_for_json:
        output_data["driversData"].append({
            "driverAbbreviation": info["abbreviation"],
            "teamColor": info["teamColor"],
            "teamName": info["teamName"],
            "laps": lap_data_for_json
        })

output_data["totalRaceTimeSeconds"] = round(max_cumulative_real_time_overall, 3)

# Calcular marcasDeVueltaIndiceProg (Índice de Progreso Acumulado del P1 de cada vuelta)
if all_laps_info_for_marks:
    all_laps_df_for_marks = pd.DataFrame(all_laps_info_for_marks)
    for lap_n in range(1, total_laps_race_from_data + 1):
        p1_on_lap = all_laps_df_for_marks[
            (all_laps_df_for_marks['lapNumber'] == lap_n) &
            (all_laps_df_for_marks['position'] == 1)
        ]
        if not p1_on_lap.empty:
            # Tomar el primer P1 si hay varios (raro, pero por si acaso) o el único
            output_data["marcasDeVueltaIndiceProg"][str(lap_n)] = round(p1_on_lap['indiceProgresoAcumulado'].iloc[0], 3)
        elif lap_n > 1 and str(lap_n-1) in output_data["marcasDeVueltaIndiceProg"]:
            # Si no hay P1 explícito para esta vuelta (ej. P1 abandonó en la vuelta anterior),
            # podríamos heredar la marca anterior o no poner nada.
            # Por simplicidad, si no hay P1, no se crea marca para esa vuelta.
            # O podríamos usar el máximo índice de progreso de cualquier piloto en esa vuelta.
             max_idx_prog_this_lap = all_laps_df_for_marks[all_laps_df_for_marks['lapNumber'] == lap_n]['indiceProgresoAcumulado'].max()
             if pd.notna(max_idx_prog_this_lap):
                 output_data["marcasDeVueltaIndiceProg"][str(lap_n)] = round(max_idx_prog_this_lap, 3)


# --- Guardar a JSON ---
try:
    with open(OUTPUT_JSON_FILE, 'w') as f:
        json.dump(output_data, f, indent=2)
    print(f"Datos procesados (con Índice de Progreso) y guardados en '{OUTPUT_JSON_FILE}'")
    print(f"Tiempo total de carrera (segundos): {output_data['totalRaceTimeSeconds']}")
    print(f"Metros pista promedio usados: {output_data['metrosPistaPromedio']}")
    print(f"Marcas de Vuelta (Índice Progreso Acumulado del P1): {output_data['marcasDeVueltaIndiceProg']}")
except IOError as e:
    print(f"Error al guardar el archivo JSON: {e}")
except Exception as e_json:
    print(f"Error durante la serialización a JSON o al procesar datos: {e_json}")
    print("Revisa los datos generados, podría haber NaNs o tipos no serializables.")