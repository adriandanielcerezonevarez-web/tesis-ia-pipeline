# Capítulo 3: Diseño e Implementación del Modelo de Inteligencia Artificial

## 3.1 Introducción al Módulo de IA

El presente capítulo describe el diseño, arquitectura e implementación del componente de inteligencia artificial que constituye el núcleo diferenciador de este trabajo de tesis. A diferencia de los pipelines CI/CD convencionales, cuya capacidad de análisis se limita a la detección de errores de compilación, fallas en pruebas unitarias y advertencias de linters, el modelo propuesto integra un sistema de análisis semántico basado en Modelos de Lenguaje de Gran Escala (LLM, por sus siglas en inglés) capaz de evaluar la calidad del código desde una perspectiva contextual y cualitativa.

La solución se construyó sobre la premisa de que los errores más costosos en el desarrollo de software no son necesariamente los técnicos (fácilmente detectables por herramientas automatizadas), sino los estructurales y de diseño: código con alta deuda técnica, baja legibilidad y resistencia al cambio que se acumula silenciosamente hasta convertirse en un problema de mantenimiento crítico.

---

## 3.2 Selección del Modelo de Inteligencia Artificial

### 3.2.1 Criterios de Selección

Para la integración con el pipeline CI/CD se evaluaron múltiples alternativas de modelos de lenguaje bajo los siguientes criterios:

- **Carácter open source:** el modelo debe estar basado en arquitecturas y pesos publicados abiertamente, en congruencia con el enfoque open source de la tesis.
- **Capacidad de análisis de código:** el modelo debe demostrar competencia en comprensión y razonamiento sobre código fuente en múltiples lenguajes de programación.
- **Eficiencia operativa:** tiempo de respuesta compatible con los tiempos de ejecución de un pipeline CI/CD (idealmente menos de 30 segundos por archivo).
- **Costo de operación:** debe ser accesible para equipos de desarrollo sin grandes presupuestos de infraestructura.
- **Calidad de las respuestas:** capacidad de estructurar análisis en formatos procesables (JSON) de forma confiable.

### 3.2.2 Modelo Seleccionado: Llama 3.1 70B vía Groq API

Tras la evaluación comparativa, se seleccionó el modelo **Llama 3.3 70B Versatile** desarrollado por Meta AI, consumido a través de la plataforma **Groq API**.

**Justificación técnica:**

Llama 3.1 es un modelo de lenguaje de gran escala completamente open source, publicado bajo la licencia Meta Llama 3.1 Community License, que permite su uso, modificación y distribución. Con 70 mil millones de parámetros, este modelo ha demostrado capacidades de razonamiento comparables a modelos propietarios de primera línea en benchmarks de comprensión de código como HumanEval y MBPP (Touvron et al., 2023).

Groq, por su parte, ofrece inferencia de Llama 3.1 a través de hardware especializado (LPU — Language Processing Unit) que reduce significativamente la latencia de respuesta en comparación con GPUs convencionales. La plataforma ofrece un nivel gratuito de 14,400 solicitudes diarias, lo que lo hace viable para equipos de desarrollo de tamaño mediano sin incurrir en costos adicionales.

La siguiente tabla resume la comparación entre las principales alternativas evaluadas:

| Modelo | Tipo | Costo | Velocidad | Calidad Código | Open Source |
|--------|------|-------|-----------|----------------|-------------|
| Llama 3.1 70B (Groq) | API | Gratuito (tier) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ✅ Sí |
| DeepSeek Coder V2 | API | Muy bajo | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ✅ Sí |
| Ollama + CodeLlama | Local | Sin costo | ⭐⭐ | ⭐⭐⭐ | ✅ Sí |
| GPT-4o (OpenAI) | API | Alto | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ❌ No |
| Claude 3 Opus | API | Alto | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ❌ No |

*Tabla 3.1: Comparación de modelos de IA para análisis de código.*

---

## 3.3 Arquitectura del Sistema

### 3.3.1 Visión General

El sistema se compone de tres capas funcionales que operan de forma coordinada dentro del pipeline CI/CD:

**Capa 1 — Orquestación (GitHub Actions):** gestiona el ciclo de vida completo del pipeline: detecta cambios en el repositorio, coordina la ejecución de los jobs de análisis y publica los resultados.

**Capa 2 — Análisis (Módulo Python):** núcleo inteligente del sistema. Extrae el código fuente modificado, lo preprocesa y lo envía al modelo de IA mediante llamadas a la API de Groq. Procesa las respuestas y genera reportes estructurados.

**Capa 3 — Modelo de IA (Llama 3.1 vía Groq):** realiza el análisis semántico del código. Recibe el código junto con un prompt de sistema cuidadosamente diseñado y retorna un análisis estructurado en formato JSON.

### 3.3.2 Flujo de Ejecución

El flujo completo del sistema se describe a continuación:

1. Un desarrollador crea o actualiza una Pull Request en el repositorio de GitHub.
2. El evento activa automáticamente el workflow de GitHub Actions definido en `.github/workflows/ai-code-review.yml`.
3. El pipeline ejecuta primero el **análisis estático tradicional** (linting con flake8 y pruebas unitarias con pytest), manteniendo compatibilidad con las prácticas convencionales de CI/CD.
4. En paralelo —o en secuencia según la configuración— el **analizador de IA** identifica los archivos de código fuente modificados en el commit usando `git diff`.
5. Para cada archivo identificado, el módulo Python lee el contenido, lo preprocesa (truncando si excede el límite de contexto del modelo) y construye el mensaje de usuario para el modelo de IA.
6. La llamada a la API de Groq envía el código junto al prompt del sistema al modelo Llama 3.1 70B, que retorna un análisis completo en formato JSON.
7. El módulo Python procesa la respuesta JSON y genera un reporte en formato Markdown.
8. El reporte se publica como comentario directamente en la Pull Request de GitHub, visible para todos los miembros del equipo de desarrollo.
9. El **Quality Gate** evalúa los resultados de ambos análisis y determina si el pipeline aprueba o bloquea el merge.

---

## 3.4 Diseño del Prompt de Sistema

### 3.4.1 Ingeniería de Prompts para Análisis de Código

El prompt de sistema es uno de los componentes más críticos del modelo, ya que define el comportamiento y las capacidades analíticas del LLM dentro del contexto del pipeline. Su diseño sigue las siguientes estrategias de ingeniería de prompts:

**Definición de rol explícita:** el prompt asigna al modelo el rol de "experto en calidad de software y revisión de código", lo que orienta las respuestas hacia un análisis técnico y constructivo en lugar de respuestas genéricas.

**Estructura de evaluación multidimensional:** en lugar de solicitar un análisis genérico, el prompt define siete dimensiones específicas de calidad que el modelo debe evaluar, garantizando cobertura sistemática de los aspectos más relevantes para la mantenibilidad del código.

**Formato de salida obligatorio:** el prompt especifica explícitamente que la respuesta debe ser un objeto JSON con una estructura predefinida. Esto es fundamental para que el módulo Python pueda procesar las respuestas de forma confiable y automatizada, sin depender de análisis de lenguaje natural no estructurado.

Las siete dimensiones de análisis definidas en el prompt son:

1. **Código Limpio (Clean Code):** evalúa el cumplimiento de principios establecidos por Robert C. Martin, incluyendo nombres descriptivos, funciones pequeñas con una sola responsabilidad, ausencia de código muerto y comentarios redundantes.

2. **Modularidad y Responsabilidad Única:** verifica el cumplimiento del Principio de Responsabilidad Única (SRP, por sus siglas en inglés), parte de los principios SOLID de diseño orientado a objetos.

3. **Legibilidad y Nomenclatura:** analiza si el código puede ser comprendido por un desarrollador nuevo sin documentación adicional, evaluando la calidad de los nombres de variables, funciones y clases.

4. **Manejo de Errores:** revisa si el código gestiona adecuadamente los casos excepcionales, errores de entrada y situaciones inesperadas.

5. **Complejidad y Mantenibilidad:** evalúa la complejidad ciclomática del código y estima el esfuerzo requerido para modificarlo o extenderlo en el futuro.

6. **Seguridad Básica:** identifica vulnerabilidades de seguridad evidentes como credenciales hardcodeadas, patrones de inyección SQL, uso inseguro de funciones de evaluación dinámica, entre otros.

7. **Documentación y Comentarios:** verifica la presencia de documentación relevante en funciones públicas, módulos y secciones de lógica compleja.

### 3.4.2 Parámetros del Modelo

La llamada al modelo utiliza los siguientes parámetros de inferencia:

- **Temperatura: 0.2** — Un valor bajo de temperatura reduce la aleatoriedad en las respuestas del modelo, favoreciendo análisis consistentes y reproducibles. Esto es crítico en un contexto de automatización donde se espera el mismo nivel de calidad de análisis en cada ejecución.
- **Tokens máximos: 4,096** — Límite suficiente para análisis detallados de archivos de tamaño mediano.

---

## 3.5 Sistema de Evaluación y Quality Gate

### 3.5.1 Métricas de Calidad

El sistema genera las siguientes métricas para cada archivo analizado:

- **Puntuación de calidad (1-10):** puntuación global calculada por el modelo considerando todas las dimensiones de análisis.
- **Nivel de riesgo:** clasificación cualitativa en cuatro niveles: BAJO, MEDIO, ALTO y CRÍTICO.
- **Aptitud para merge:** decisión booleana que indica si el archivo puede integrarse al código base sin comprometer la calidad del proyecto.

### 3.5.2 Quality Gate

El Quality Gate es el mecanismo que conecta el análisis de IA con las decisiones de control de flujo del pipeline. Funciona bajo las siguientes reglas:

El pipeline **bloquea el merge** si se cumple cualquiera de las siguientes condiciones:
- Al menos un archivo recibe una calificación de "no apto para merge" por parte del modelo de IA.
- La puntuación de calidad promedio de todos los archivos analizados cae por debajo del umbral configurado (valor predeterminado: 5.0/10).
- El análisis estático tradicional (linting o pruebas unitarias) reporta errores críticos.

El umbral de calidad es configurable, lo que permite a los equipos de desarrollo ajustar el nivel de rigor según la madurez del proyecto y los estándares de la organización.

---

## 3.6 Integración con GitHub Actions

### 3.6.1 Estructura del Workflow

El workflow de GitHub Actions se organiza en tres jobs que modelan el pipeline completo:

**Job 1 — Análisis Estático Tradicional:** ejecuta las herramientas convencionales de validación de código (flake8 para linting, pytest para pruebas unitarias). Este job mantiene la compatibilidad con las prácticas establecidas de CI/CD y sirve como primera línea de validación.

**Job 2 — Análisis de Calidad con IA:** este es el job central de la innovación propuesta. Detecta los archivos modificados, ejecuta el analizador Python que llama al modelo Llama 3.1 a través de Groq API, y publica el reporte resultante como comentario en la Pull Request.

**Job 3 — Quality Gate Final:** consolida los resultados de los dos jobs anteriores y emite el veredicto final del pipeline. Bloquea o aprueba el merge según las reglas definidas en la sección 3.5.2.

### 3.6.2 Gestión de Secretos y Seguridad

La clave de API de Groq se almacena como un secreto cifrado en la configuración del repositorio de GitHub (`Settings > Secrets and variables > Actions`), bajo el nombre `GROQ_API_KEY`. Esta práctica garantiza que la credencial nunca quede expuesta en el código fuente ni en los logs del pipeline.

---

## 3.7 Flujo de Datos y Preprocesamiento

### 3.7.1 Detección de Archivos Modificados

El sistema utiliza el comando `git diff` para identificar únicamente los archivos que fueron modificados en el commit o Pull Request que desencadenó el pipeline. Esta estrategia optimiza el uso de la API al analizar exclusivamente el código nuevo o modificado, reduciendo costos y tiempos de ejecución.

Los formatos de archivo soportados incluyen: Python (.py), JavaScript (.js), TypeScript (.ts), JSX/TSX, Java, Go, Ruby, PHP, C#, C/C++, Swift, Kotlin y Rust.

### 3.7.2 Preprocesamiento del Código

Antes de enviar el código al modelo de IA, el módulo aplica los siguientes pasos de preprocesamiento:

**Truncamiento inteligente:** si el contenido de un archivo excede los 12,000 caracteres (aproximadamente 300 líneas de código), el sistema trunca el texto e incluye una nota indicando la cantidad de caracteres no mostrados. Esto evita exceder los límites de contexto del modelo mientras se mantiene la coherencia del análisis.

**Limpieza de respuestas:** dado que los modelos de lenguaje ocasionalmente envuelven el JSON en bloques de código Markdown (usando ` ```json `), el módulo implementa lógica de limpieza para extraer el JSON puro antes de procesarlo.

---

## 3.8 Reporte de Resultados

### 3.8.1 Formato del Reporte

El sistema genera un reporte en formato Markdown con las siguientes secciones:

- **Resumen Ejecutivo:** tabla con métricas globales (archivos analizados, puntuación promedio, archivos que bloquean el merge).
- **Detalle por archivo:** para cada archivo analizado, el reporte incluye la puntuación de calidad, nivel de riesgo, estado de aptitud para merge, problemas críticos, recomendaciones prioritarias y análisis detallado por dimensión.
- **Tabla de dimensiones:** resumen visual del estado de cada dimensión de calidad con indicadores de color (verde/amarillo/naranja/rojo).
- **Detalles expandibles:** los hallazgos y recomendaciones de cada dimensión se presentan en secciones colapsables para mantener la legibilidad del reporte.

### 3.8.2 Publicación en Pull Request

El reporte se publica automáticamente como comentario en la Pull Request de GitHub mediante la API de GitHub. El sistema verifica si ya existe un comentario previo del bot (de análisis anteriores) y lo actualiza en lugar de crear un nuevo comentario, manteniendo limpia la sección de comentarios del PR.

---

## 3.9 Consideraciones sobre la Implementación

### 3.9.1 Limitaciones Identificadas

Durante el diseño del sistema se identificaron las siguientes limitaciones que deben considerarse al interpretar los resultados del análisis:

**Dependencia de conectividad:** el sistema requiere acceso a internet para comunicarse con la API de Groq. En entornos con restricciones de red, se contempla la alternativa de desplegar modelos localmente mediante Ollama, aunque con menor velocidad de inferencia.

**Subjetividad del análisis:** si bien el modelo produce análisis consistentes, la evaluación de aspectos cualitativos como la legibilidad o el diseño tiene un componente inherente de subjetividad. Los resultados deben interpretarse como orientaciones y no como veredictos absolutos.

**Truncamiento de archivos grandes:** archivos que excedan el límite de preprocesamiento pueden recibir análisis incompletos. Se recomienda refactorizar archivos de más de 300 líneas como buena práctica independiente del sistema.

### 3.9.2 Ventajas Competitivas del Modelo

Frente a los pipelines CI/CD convencionales, el modelo implementado ofrece las siguientes ventajas:

- Capacidad de análisis semántico y contextual que va más allá de la sintaxis.
- Detección de anti-patrones y deuda técnica no identificables por linters.
- Generación de recomendaciones específicas, accionables y educativas para el desarrollador.
- Configurabilidad del umbral de calidad según los estándares del equipo.
- Retroalimentación integrada directamente en el flujo de trabajo (Pull Request), sin requerir herramientas adicionales.

---

## 3.10 Conclusiones del Capítulo

El modelo de inteligencia artificial diseñado en este capítulo representa una evolución significativa en las capacidades de los pipelines CI/CD open source. Al integrar un modelo de lenguaje de gran escala (Llama 3.1 70B) en el flujo de revisión de código, el sistema extiende el análisis más allá de los errores técnicos detectables por herramientas convencionales, abordando dimensiones cualitativas de la calidad del software que históricamente han dependido de la revisión manual por parte de desarrolladores experimentados.

La arquitectura propuesta mantiene la compatibilidad con las prácticas establecidas de CI/CD, complementando —y no reemplazando— las herramientas tradicionales. La elección de modelos open source y plataformas con niveles gratuitos garantiza la viabilidad económica de la solución para equipos de desarrollo de distintos tamaños y presupuestos, alineándose con el objetivo de democratizar el acceso a análisis de calidad de código de alto nivel.

---

*Referencias citadas en este capítulo:*

- Touvron, H., et al. (2023). *Llama 2: Open Foundation and Fine-Tuned Chat Models*. Meta AI Research.
- Martin, R. C. (2008). *Clean Code: A Handbook of Agile Software Craftsmanship*. Prentice Hall.
- Martin, R. C. (2002). *Agile Software Development, Principles, Patterns, and Practices*. Prentice Hall.
- Groq Inc. (2024). *Groq API Documentation*. https://console.groq.com/docs
