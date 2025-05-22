import fastf1 as ff1
import fastf1.plotting # Asegúrate de que plotting esté importado
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
    session.load(laps=True, telemetry=False, weather=False, messages=False)
    laps_data = session.laps
except Exception as e:
    print(f"Error al cargar datos de la sesión: {e}")
    exit()

if laps_data is None or laps_data.empty:
    print(f"No se encontraron datos de vueltas para {RACE_EVENT} {RACE_YEAR}.")
    exit()

print("Datos cargados. Procesando...")

actual_metros_pista = METROS_PISTA_PROMEDIO # De momento, mantenemos el valor fijo
# (La lógica para obtenerlo dinámicamente puede añadirse después si es necesario)
print(f"Usando METROS_PISTA_PROMEDIO = {actual_metros_pista}")

total_laps_race_from_data = int(laps_data['LapNumber'].max())
event_name = session.event['EventName']
event_year = RACE_YEAR

output_data = {
    "eventName": event_name,
    "eventYear": event_year,
    "totalRaceTimeSeconds": 0,
    "totalLaps": total_laps_race_from_data,
    "metrosPistaPromedio": actual_metros_pista,
    "marcasDeVueltaIndiceProg": {},
    "driversData": []
}

# --- Obtener información de pilotos y COLORES (Lógica Revisada) ---
driver_info_map = {} 

# Primero, poblar con session.results si está disponible, ya que suele tener buena info
if hasattr(session, 'results') and session.results is not None and not session.results.empty:
    for _, r_info in session.results.iterrows():
        driver_number_str = str(r_info['DriverNumber']) # Usar string como clave consistente
        abbr = r_info['Abbreviation']
        team_name = r_info['TeamName'] # Nombre completo del equipo
        full_name = r_info['FullName'] if 'FullName' in r_info else f"{r_info.get('FirstName', '')} {r_info.get('LastName', '')}".strip()


        # Lógica para obtener color
        color = '#808080' # Color de fallback
        
        # Intentar obtener color del piloto primero
        try:
            # FastF1 v3.1+ usa session_event_year y session_type
            # Para versiones anteriores, year y session_type
            # Vamos a intentar detectar la versión de fastf1 para usar los params correctos
            # o simplemente probar ambos si es más fácil que detectar la versión
            
            # Intento para FastF1 >= v3.1 (más nuevo)
            # Necesitamos el año del evento de la sesión, no RACE_YEAR directamente a veces
            session_event_year_for_color = session.event.SessionInfo.Meeting.FIAConfig.CurrentYear if hasattr(session.event, 'SessionInfo') else RACE_YEAR

            # print(f"Debug Color - Piloto: {abbr}, Equipo: {team_name}, Año Sesión: {session_event_year_for_color}, Nombre Sesión: {session.name}")

            col_candidate_driver = fastf1.plotting.get_driver_color(abbr, session_event_year=session_event_year_for_color, session_type=session.name)
            if pd.notna(col_candidate_driver) and isinstance(col_candidate_driver, str) and col_candidate_driver.startswith('#'):
                color = col_candidate_driver
                # print(f"  Color encontrado para piloto {abbr}: {color}")
            else:
                # Si no se encuentra por piloto, intentar por equipo
                col_candidate_team = fastf1.plotting.team_color(team_name, session_event_year=session_event_year_for_color)
                if pd.notna(col_candidate_team) and isinstance(col_candidate_team, str) and col_candidate_team.startswith('#'):
                    color = col_candidate_team
                    # print(f"  Color encontrado para equipo {team_name} (via piloto {abbr}): {color}")
                # else:
                    # print(f"  Color NO encontrado para equipo {team_name} (via piloto {abbr}). Fallback a gris.")
        except AttributeError: # Podría ser una versión más antigua de FastF1
            try:
                col_candidate_driver = fastf1.plotting.get_driver_color(abbr, year=RACE_YEAR, session_name=session.name) # session_name o session_type
                if pd.notna(col_candidate_driver) and isinstance(col_candidate_driver, str) and col_candidate_driver.startswith('#'):
                     color = col_candidate_driver
                else:
                    col_candidate_team = fastf1.plotting.team_color(team_name, year=RACE_YEAR)
                    if pd.notna(col_candidate_team) and isinstance(col_candidate_team, str) and col_candidate_team.startswith('#'):
                        color = col_candidate_team
            except Exception as e_color_old:
                print(f"Advertencia: Falló el intento de color (método antiguo) para {abbr}/{team_name}: {e_color_old}")
        except Exception as e_color_new:
            print(f"Advertencia: Falló el intento de color (método nuevo) para {abbr}/{team_name}: {e_color_new}")


        driver_info_map[driver_number_str] = {
            "abbreviation": abbr,
            "teamName": team_name,
            "fullName": full_name,
            "teamColor": color
        }

# Complementar con laps_data para pilotos que no estén en results (ej. no clasificados)
# o si results no tenía toda la info
unique_driver_numbers_laps = laps_data['DriverNumber'].astype(str).unique() # Asegurar que sean strings

for dr_num_str_laps in unique_driver_numbers_laps:
    if dr_num_str_laps not in driver_info_map:
        try:
            # Tomar la primera aparición del piloto en laps_data para obtener su 'Driver' (abbr) y 'Team'
            driver_laps_subset = laps_data[laps_data['DriverNumber'] == dr_num_str_laps].iloc[0]
            abbr = driver_laps_subset['Driver'] # En laps_data, 'Driver' suele ser la abreviatura
            team_name = driver_laps_subset['Team'] # Y 'Team' el nombre del equipo
            
            # Reintentar lógica de color para este piloto/equipo
            color = '#808080'
            session_event_year_for_color = session.event.SessionInfo.Meeting.FIAConfig.CurrentYear if hasattr(session.event, 'SessionInfo') else RACE_YEAR
            # print(f"Debug Color (desde laps_data) - Piloto: {abbr}, Equipo: {team_name}, Año Sesión: {session_event_year_for_color}, Nombre Sesión: {session.name}")

            col_candidate_driver = fastf1.plotting.get_driver_color(abbr, session_event_year=session_event_year_for_color, session_type=session.name)
            if pd.notna(col_candidate_driver) and isinstance(col_candidate_driver, str) and col_candidate_driver.startswith('#'):
                color = col_candidate_driver
            else:
                col_candidate_team = fastf1.plotting.team_color(team_name, session_event_year=session_event_year_for_color)
                if pd.notna(col_candidate_team) and isinstance(col_candidate_team, str) and col_candidate_team.startswith('#'):
                    color = col_candidate_team
            
            driver_info_map[dr_num_str_laps] = {
                "abbreviation": abbr,
                "teamName": team_name,
                "fullName": f"Driver {abbr}", # Fallback para nombre completo
                "teamColor": color
            }
            print(f"Info para {abbr} (desde laps_data) añadida con color: {color}")
        except IndexError:
            print(f"Advertencia: No se pudo obtener información del piloto para DriverNumber {dr_num_str_laps} desde laps_data.")
            driver_info_map[dr_num_str_laps] = {"abbreviation": f"DRV{dr_num_str_laps}", "teamName": "Unknown", "fullName": f"Driver {dr_num_str_laps}", "teamColor": "#808080"}
        except Exception as e_laps_color:
             print(f"Error obteniendo color para {abbr} (desde laps_data): {e_laps_color}")
             driver_info_map[dr_num_str_laps] = {"abbreviation": abbr, "teamName": team_name, "fullName": f"Driver {abbr}", "teamColor": "#808080"}


# --- Recopilar datos de vuelta con Índice de Progreso ---
# (Esta parte del código no cambia con respecto a la anterior, se mantiene igual)
max_cumulative_real_time_overall = 0
all_laps_info_for_marks = []

for driver_number_str, info in driver_info_map.items():
    driver_laps_df = laps_data[laps_data['DriverNumber'] == driver_number_str].copy()

    if 'LapTime' not in driver_laps_df.columns or 'Position' not in driver_laps_df.columns:
        # print(f"Advertencia: 'LapTime' o 'Position' no encontrado para {info['abbreviation']}. Saltando procesamiento de vueltas.")
        continue
    
    driver_laps_df.dropna(subset=['LapTime', 'Position'], inplace=True)
    if driver_laps_df.empty:
        # print(f"Info: No hay vueltas válidas con LapTime y Position para {info['abbreviation']}.")
        continue

    if pd.api.types.is_timedelta64_dtype(driver_laps_df['LapTime']):
        driver_laps_df['IndividualLapTimeSeconds'] = driver_laps_df['LapTime'].dt.total_seconds()
    else:
        driver_laps_df['IndividualLapTimeSeconds'] = pd.to_numeric(driver_laps_df['LapTime'], errors='coerce')
    
    driver_laps_df.dropna(subset=['IndividualLapTimeSeconds'], inplace=True)
    if driver_laps_df.empty:
        continue

    driver_laps_df = driver_laps_df.sort_values(by='LapNumber')
    driver_laps_df['CumulativeRealTimeSeconds'] = driver_laps_df['IndividualLapTimeSeconds'].cumsum()
    
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
            "driverAbbreviation": info["abbreviation"], # Necesario para identificar P1
            "position": pos,
            "indiceProgresoAcumulado": idx_prog_acum
        })

        if cum_real_time > max_cumulative_real_time_overall:
            max_cumulative_real_time_overall = cum_real_time
            
    if lap_data_for_json:
        output_data["driversData"].append({
            "driverAbbreviation": info["abbreviation"],
            "teamColor": info["teamColor"], # Asegurarse de que el color del driver_info_map se usa
            "teamName": info["teamName"],
            "fullName": info.get("fullName", info["abbreviation"]), # Usar fullName si existe
            "laps": lap_data_for_json
        })

output_data["totalRaceTimeSeconds"] = round(max_cumulative_real_time_overall, 3)

if all_laps_info_for_marks:
    all_laps_df_for_marks = pd.DataFrame(all_laps_info_for_marks)
    for lap_n in range(1, total_laps_race_from_data + 1):
        # Encontrar el piloto en P1 en esa vuelta
        p1_driver_lap_data = all_laps_df_for_marks[
            (all_laps_df_for_marks['lapNumber'] == lap_n) &
            (all_laps_df_for_marks['position'] == 1)
        ]
        if not p1_driver_lap_data.empty:
            # Puede haber múltiples entradas si los datos no están perfectamente limpios, tomar la primera.
            output_data["marcasDeVueltaIndiceProg"][str(lap_n)] = round(p1_driver_lap_data['indiceProgresoAcumulado'].iloc[0], 3)
        elif lap_n > 1 and str(lap_n-1) in output_data["marcasDeVueltaIndiceProg"]:
             max_idx_prog_this_lap = all_laps_df_for_marks[all_laps_df_for_marks['lapNumber'] == lap_n]['indiceProgresoAcumulado'].max()
             if pd.notna(max_idx_prog_this_lap):
                 output_data["marcasDeVueltaIndiceProg"][str(lap_n)] = round(max_idx_prog_this_lap, 3)

# --- Guardar a JSON ---
try:
    with open(OUTPUT_JSON_FILE, 'w') as f:
        json.dump(output_data, f, indent=2)
    print(f"Datos procesados y guardados en '{OUTPUT_JSON_FILE}'")
    # print(f"Marcas de Vuelta (Índice Progreso Acumulado del P1): {output_data['marcasDeVueltaIndiceProg']}")
    # Imprimir un resumen de colores para verificar
    print("\nResumen de colores generados:")
    for driver_data in output_data["driversData"]:
        print(f"  {driver_data['driverAbbreviation']}: {driver_data['teamColor']}")

except IOError as e:
    print(f"Error al guardar el archivo JSON: {e}")
except Exception as e_json:
    print(f"Error durante la serialización a JSON o al procesar datos: {e_json}")