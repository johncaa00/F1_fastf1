import fastf1 as ff1
import fastf1.plotting 
import pandas as pd
import json
import os

# --- Configuración ---
RACE_YEAR = 2023
RACE_EVENT = 'Bahrain Grand Prix' 
OUTPUT_JSON_FILE = 'race_data.json'
METROS_PISTA_PROMEDIO = 5412 

# --- Habilitar el caché de FastF1 ---
CACHE_DIR = 'fastf1_cache'
if not os.path.exists(CACHE_DIR):
    try: os.makedirs(CACHE_DIR); print(f"Directorio de caché '{CACHE_DIR}' creado.")
    except OSError as e: print(f"Error creando directorio caché: {e}"); exit()
try: ff1.Cache.enable_cache(CACHE_DIR)
except Exception as e: print(f"Error habilitando caché: {e}"); exit()

print(f"Cargando datos para {RACE_EVENT} {RACE_YEAR}...")
try:
    session = ff1.get_session(RACE_YEAR, RACE_EVENT, 'R')
    session.load(laps=True, telemetry=False, weather=False, messages=False)
    laps_data = session.laps
except Exception as e: print(f"Error cargando sesión: {e}"); exit()

if laps_data is None or laps_data.empty: print(f"No hay datos de vueltas para {RACE_EVENT} {RACE_YEAR}."); exit()
print("Datos cargados. Procesando...")

actual_metros_pista = METROS_PISTA_PROMEDIO
total_laps_race_from_data = int(laps_data['LapNumber'].max())
event_name = session.event['EventName']
event_year_from_session = session.event.year
num_total_starters = len(laps_data['DriverNumber'].unique()) # Número de pilotos que iniciaron

output_data = {
    "eventName": event_name, "eventYear": event_year_from_session,
    "totalRaceTimeSeconds": 0, "totalLaps": total_laps_race_from_data,
    "metrosPistaPromedio": actual_metros_pista,
    "marcasDeVueltaIndiceProg": {}, "driversData": []
}

driver_info_map = {} 
# print("\n--- Obteniendo Colores ---") # Descomentar para depurar colores
if hasattr(session, 'results') and session.results is not None and not session.results.empty:
    for _, r_info in session.results.iterrows():
        dr_str = str(r_info['DriverNumber']); abbr = r_info['Abbreviation']; team_orig = r_info['TeamName']
        full_name = r_info.get('FullName', f"{r_info.get('FirstName', '')} {r_info.get('LastName', '')}".strip())
        color = '#808080'
        try:
            col_team = fastf1.plotting.get_team_color(team_orig, session=session)
            if pd.notna(col_team) and isinstance(col_team, str) and col_team.startswith('#'): color = col_team
        except Exception: pass # print(f"Error color para {abbr}: {e}")
        driver_info_map[dr_str] = {"abbreviation": abbr, "teamName": team_orig, "fullName": full_name, "teamColor": color}

unique_driver_numbers_laps = laps_data['DriverNumber'].astype(str).unique()
for dr_num_str_laps in unique_driver_numbers_laps:
    if dr_num_str_laps in driver_info_map and driver_info_map[dr_num_str_laps]['teamColor'] != '#808080': continue
    try:
        subset = laps_data[laps_data['DriverNumber'] == dr_num_str_laps].iloc[0]
        abbr_l = subset['Driver']; team_l = subset['Team']; color_l = '#808080'
        try:
            col_team_l = fastf1.plotting.get_team_color(team_l, session=session)
            if pd.notna(col_team_l) and isinstance(col_team_l, str) and col_team_l.startswith('#'): color_l = col_team_l
        except Exception: pass
        driver_info_map[dr_num_str_laps] = {"abbreviation": abbr_l, "teamName": team_l, 
                                            "fullName": driver_info_map.get(dr_num_str_laps, {}).get('fullName', f"Driver {abbr_l}"),
                                            "teamColor": color_l}
    except Exception: 
        if dr_num_str_laps not in driver_info_map: driver_info_map[dr_num_str_laps] = {"abbreviation": f"DRV{dr_num_str_laps}", "teamName": "Unknown", "fullName": f"Driver {dr_num_str_laps}", "teamColor": "#808080"}
# print("--- Fin Colores ---")

max_cumulative_real_time_overall = 0
all_laps_info_for_marks = []
processed_drivers_for_sorting = [] 

all_valid_lap_times = laps_data['LapTime'].dropna().dt.total_seconds()
slowest_lap_time_estimate = all_valid_lap_times.max() * 1.5 if not all_valid_lap_times.empty else 300 

for driver_number_str, info in driver_info_map.items():
    driver_laps_df = laps_data[laps_data['DriverNumber'] == driver_number_str].copy()
    original_laps_for_driver = []
    last_known_position = num_total_starters 
    last_known_cumulative_real_time = 0
    last_known_indice_prog_acum = 0
    max_lap_completed_by_driver = 0
    time_of_last_real_lap = 0 # Tiempo en el que completó su última vuelta real

    if not driver_laps_df.empty and 'LapTime' in driver_laps_df.columns and 'Position' in driver_laps_df.columns:
        driver_laps_df.dropna(subset=['LapTime', 'Position'], inplace=True)
        if not driver_laps_df.empty:
            if pd.api.types.is_timedelta64_dtype(driver_laps_df['LapTime']):
                driver_laps_df['IndividualLapTimeSeconds'] = driver_laps_df['LapTime'].dt.total_seconds()
            else:
                driver_laps_df['IndividualLapTimeSeconds'] = pd.to_numeric(driver_laps_df['LapTime'], errors='coerce')
            driver_laps_df.dropna(subset=['IndividualLapTimeSeconds'], inplace=True)

            if not driver_laps_df.empty:
                driver_laps_df = driver_laps_df.sort_values(by='LapNumber')
                driver_laps_df['CumulativeRealTimeSeconds'] = driver_laps_df['IndividualLapTimeSeconds'].cumsum()
                driver_laps_df['IndiceProgresoVuelta'] = driver_laps_df['IndividualLapTimeSeconds'].apply(
                    lambda x: (actual_metros_pista / x) if x > 0 else 0)
                driver_laps_df['IndiceProgresoAcumulado'] = driver_laps_df['IndiceProgresoVuelta'].cumsum()

                for _, row in driver_laps_df.iterrows():
                    original_laps_for_driver.append({
                        "lapNumber": int(row['LapNumber']), "position": int(row['Position']),
                        "individualLapTimeSeconds": round(row['IndividualLapTimeSeconds'], 3),
                        "cumulativeRealTimeSeconds": round(row['CumulativeRealTimeSeconds'], 3),
                        "indiceProgresoVuelta": round(row['IndiceProgresoVuelta'], 3),
                        "indiceProgresoAcumulado": round(row['IndiceProgresoAcumulado'], 3),
                        "isRetiredFill": False 
                    })
                last_row = driver_laps_df.iloc[-1]
                last_known_position = int(last_row['Position'])
                last_known_cumulative_real_time = round(last_row['CumulativeRealTimeSeconds'], 3)
                last_known_indice_prog_acum = round(last_row['IndiceProgresoAcumulado'], 3)
                max_lap_completed_by_driver = int(last_row['LapNumber'])
                time_of_last_real_lap = last_known_cumulative_real_time
    
    processed_drivers_for_sorting.append({
        "abbreviation": info["abbreviation"], "teamColor": info["teamColor"],
        "teamName": info["teamName"], "fullName": info.get("fullName", info["abbreviation"]),
        "laps_real_data": list(original_laps_for_driver), # Guardar solo las vueltas reales aquí
        "maxLapCompleted": max_lap_completed_by_driver,
        "lastKnownPosition": last_known_position,
        "lastKnownIndiceProgAcum": last_known_indice_prog_acum,
        "lastKnownCumulativeRealTime": last_known_cumulative_real_time,
        "timeOfLastRealLap": time_of_last_real_lap
    })

# Ordenar pilotos para asignar posiciones de retirados correctamente:
# 1. Por número de vueltas completadas (descendente - los que más completaron van primero)
# 2. Por su última posición conocida en su última vuelta real (ascendente - el que iba mejor clasificado va primero)
processed_drivers_for_sorting.sort(key=lambda x: (-x["maxLapCompleted"], x["lastKnownPosition"]))

# Asignar posiciones finales (incluyendo retirados) y rellenar vueltas
next_available_position = 1
assigned_retired_positions = {} # Para asegurar que cada retirado tenga una única posición final

drivers_who_finished = [d for d in processed_drivers_for_sorting if d["maxLapCompleted"] == total_laps_race_from_data]
retired_drivers = [d for d in processed_drivers_for_sorting if d["maxLapCompleted"] < total_laps_race_from_data]

# Las posiciones de los que terminaron ya son correctas en su última vuelta real
for driver_data in drivers_who_finished:
    driver_data["finalAssignedPosition"] = driver_data["lastKnownPosition"] # Su posición final es la de la última vuelta

# Asignar posiciones a los retirados "de abajo hacia arriba"
# Los que se retiraron antes (menos vueltas) o iban peor, obtienen las últimas posiciones.
# El sort ya los tiene en orden: los que más vueltas completaron (y mejor posición) están primeros entre los retirados.
# Así que iteramos en orden inverso de esta lista de retirados para asignar P_total, P_total-1, etc.
current_final_pos_for_retired = num_total_starters
for driver_data in reversed(retired_drivers): # Empezar desde el que menos progresó
    driver_data["finalAssignedPosition"] = current_final_pos_for_retired
    current_final_pos_for_retired -= 1


# Ahora construir el `output_data["driversData"]` final con todas las vueltas
for driver_data_sorted in processed_drivers_for_sorting:
    all_laps_for_this_driver_json = list(driver_data_sorted["laps_real_data"])
    
    last_real_lap_data = {}
    if driver_data_sorted["laps_real_data"]:
        last_real_lap_data = driver_data_sorted["laps_real_data"][-1]
    else: # Piloto sin vueltas reales (ej. DNS)
        last_real_lap_data = {
            "lapNumber": 0, "position": driver_data_sorted["finalAssignedPosition"],
            "individualLapTimeSeconds": slowest_lap_time_estimate, 
            "cumulativeRealTimeSeconds": 0,
            "indiceProgresoVuelta": 0, "indiceProgresoAcumulado": 0,
            "isRetiredFill": True
        }

    current_cumulative_time = last_real_lap_data["cumulativeRealTimeSeconds"]
    
    if driver_data_sorted["maxLapCompleted"] < total_laps_race_from_data:
        for lap_fill in range(driver_data_sorted["maxLapCompleted"] + 1, total_laps_race_from_data + 1):
            current_cumulative_time += slowest_lap_time_estimate 
            all_laps_for_this_driver_json.append({
                "lapNumber": lap_fill,
                "position": driver_data_sorted["finalAssignedPosition"], # Usar la posición final asignada
                "individualLapTimeSeconds": round(slowest_lap_time_estimate, 3),
                "cumulativeRealTimeSeconds": round(current_cumulative_time, 3),
                "indiceProgresoVuelta": 0,
                "indiceProgresoAcumulado": last_real_lap_data["indiceProgresoAcumulado"], # Mantiene el último índice real
                "isRetiredFill": True
            })
            
    output_data["driversData"].append({
        "driverAbbreviation": driver_data_sorted["abbreviation"], 
        "teamColor": driver_data_sorted["teamColor"],
        "teamName": driver_data_sorted["teamName"], 
        "fullName": driver_data_sorted.get("fullName", driver_data_sorted["abbreviation"]),
        "laps": all_laps_for_this_driver_json
    })
    
    # Para marcas de vuelta y max_cumulative_real_time_overall
    for lap_entry in all_laps_for_this_driver_json: # Usar todas las vueltas (reales y de relleno) para el tiempo total del slider
        if not lap_entry["isRetiredFill"]: # Solo vueltas reales para marcas
             all_laps_info_for_marks.append({
                "lapNumber": lap_entry["lapNumber"], "driverAbbreviation": driver_data_sorted["abbreviation"],
                "position": lap_entry["position"], "indiceProgresoAcumulado": lap_entry["indiceProgresoAcumulado"]
            })
        if lap_entry["cumulativeRealTimeSeconds"] > max_cumulative_real_time_overall:
             max_cumulative_real_time_overall = lap_entry["cumulativeRealTimeSeconds"]

output_data["totalRaceTimeSeconds"] = round(max_cumulative_real_time_overall, 3)

# Calcular marcasDeVueltaIndiceProg (del P1 real de cada vuelta)
if all_laps_info_for_marks:
    all_laps_df_for_marks = pd.DataFrame(all_laps_info_for_marks)
    for lap_n in range(1, total_laps_race_from_data + 1):
        p1_driver_lap_data = all_laps_df_for_marks[
            (all_laps_df_for_marks['lapNumber'] == lap_n) & (all_laps_df_for_marks['position'] == 1)]
        if not p1_driver_lap_data.empty:
            output_data["marcasDeVueltaIndiceProg"][str(lap_n)] = round(p1_driver_lap_data['indiceProgresoAcumulado'].iloc[0], 3)
        elif lap_n > 0 : 
             lap_n_data = all_laps_df_for_marks[all_laps_df_for_marks['lapNumber'] == lap_n]
             if not lap_n_data.empty:
                max_idx_prog_this_lap = lap_n_data['indiceProgresoAcumulado'].max()
                if pd.notna(max_idx_prog_this_lap): output_data["marcasDeVueltaIndiceProg"][str(lap_n)] = round(max_idx_prog_this_lap, 3)
             elif lap_n > 1 and str(lap_n-1) in output_data["marcasDeVueltaIndiceProg"]:
                 output_data["marcasDeVueltaIndiceProg"][str(lap_n)] = output_data["marcasDeVueltaIndiceProg"][str(lap_n-1)]

try:
    with open(OUTPUT_JSON_FILE, 'w') as f: json.dump(output_data, f, indent=2)
    print(f"Datos procesados y guardados en '{OUTPUT_JSON_FILE}'")
    print("\nResumen de colores generados:")
    for driver_data in output_data["driversData"]: print(f"  {driver_data['driverAbbreviation']} ({driver_data['teamName']}): {driver_data['teamColor']}")
except IOError as e: print(f"Error al guardar el archivo JSON: {e}")
except Exception as e_json: print(f"Error durante la serialización o procesamiento: {e_json}")