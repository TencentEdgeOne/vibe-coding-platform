import type { MovieDetails } from "./types.js";

// Read on the server by the +data.ts files beside it, so the data-fetching
// demo renders the same with or without a network.
export const starWarsMovies: MovieDetails[] = [
  {
    id: "1",
    title: "A New Hope",
    release_date: "1977-05-25",
    director: "George Lucas",
    producer: "Gary Kurtz",
  },
  {
    id: "2",
    title: "The Empire Strikes Back",
    release_date: "1980-05-21",
    director: "Irvin Kershner",
    producer: "Gary Kurtz",
  },
  {
    id: "3",
    title: "Return of the Jedi",
    release_date: "1983-05-25",
    director: "Richard Marquand",
    producer: "Howard Kazanjian",
  },
  {
    id: "4",
    title: "The Phantom Menace",
    release_date: "1999-05-19",
    director: "George Lucas",
    producer: "Rick McCallum",
  },
  {
    id: "5",
    title: "Attack of the Clones",
    release_date: "2002-05-16",
    director: "George Lucas",
    producer: "Rick McCallum",
  },
  {
    id: "6",
    title: "Revenge of the Sith",
    release_date: "2005-05-19",
    director: "George Lucas",
    producer: "Rick McCallum",
  },
];
